import type {
  CreateWebhookEndpoint,
  WebhookEndpoint,
  WebhookEventName,
} from "@repo/contracts"
import { desc, eq } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { webhookEndpoints } from "../db/core.js"
import { checkEndpointUrl } from "./endpoints.js"
import {
  generateKey,
  liveRetiring,
  planRotation,
  type PreviousSecretChoice,
  type RetiringSecret,
  type SignatureScheme,
} from "./keys.js"
import type { SecretBox } from "./signing.js"
import type { EgressVerdict } from "./egress.js"

/**
 * The customer-facing half of webhooks: registering endpoints.
 *
 * ⚠ THE SECRET IS GENERATED HERE, RETURNED ONCE, AND STORED SEALED. It is the
 * only thing that distinguishes our POST from anyone else's, so it is created
 * where it can be handed back in the same response and never held anywhere it
 * could be read again. For ed25519 the private key never leaves us at all; the
 * customer gets the public key, which is on every response.
 */

/** An endpoint with the secret shown once. `null` for ed25519. */
export type EndpointWithSecret = WebhookEndpoint & { secret: string | null }

export type RotateResult =
  | { status: "rotated"; endpoint: EndpointWithSecret }
  | { status: "rejected"; reason: string }
  | { status: "not_found" }

export interface WebhookEndpointStore {
  create: (
    tenantId: string,
    input: CreateWebhookEndpoint,
  ) => Promise<
    | { status: "created"; endpoint: EndpointWithSecret }
    | { status: "rejected"; reason: string }
  >
  list: (tenantId: string) => Promise<WebhookEndpoint[]>
  remove: (tenantId: string, id: string) => Promise<boolean>
  /**
   * ⚠ `previous` HAS NO DEFAULT. What happens to the key being replaced is the
   * customer's decision (docs/decisions/webhooks.md, decision 7).
   */
  rotateSecret: (
    tenantId: string,
    id: string,
    previous: PreviousSecretChoice,
    scheme?: SignatureScheme,
  ) => Promise<RotateResult>
  /** Ends every grace period now: only the current key signs from here on. */
  revokePreviousSecrets: (
    tenantId: string,
    id: string,
  ) => Promise<WebhookEndpoint | null>
}

type Row = {
  id: string
  url: string
  events: string[]
  description: string | null
  enabled: boolean
  disabledReason: string | null
  createdAt: Date
  signatureScheme: SignatureScheme
  rateLimit: number | null
  publicKey: string | null
  retiringSecrets: RetiringSecret[]
}

const present = (row: Row, now = new Date()): WebhookEndpoint => ({
  object: "webhook_endpoint",
  id: row.id,
  url: row.url,
  events: row.events as WebhookEventName[],
  description: row.description,
  enabled: row.enabled,
  disabled_reason: row.enabled ? null : row.disabledReason,
  created_at: row.createdAt.toISOString(),
  signature_scheme: row.signatureScheme,
  rate_limit: row.rateLimit,
  public_key: row.publicKey,
  // Expired entries are not keys any more, whatever the row still holds.
  previous_secrets: liveRetiring(row.retiringSecrets, now).map((r) => ({
    signature_scheme: r.scheme,
    expires_at: r.expiresAt,
  })),
})

const COLUMNS = {
  id: webhookEndpoints.id,
  url: webhookEndpoints.url,
  events: webhookEndpoints.events,
  description: webhookEndpoints.description,
  enabled: webhookEndpoints.enabled,
  disabledReason: webhookEndpoints.disabledReason,
  createdAt: webhookEndpoints.createdAt,
  signatureScheme: webhookEndpoints.signatureScheme,
  rateLimit: webhookEndpoints.rateLimit,
  publicKey: webhookEndpoints.publicKey,
  retiringSecrets: webhookEndpoints.retiringSecrets,
}

/** The secret a customer is shown: the HMAC secret, never an ed25519 private key. */
const shown = (key: { scheme: SignatureScheme; secret: string }) =>
  key.scheme === "hmac_sha256" ? key.secret : null

export interface WebhookEndpointStoreOptions {
  /**
   * Resolves the endpoint's hostname at registration, so one that already
   * points somewhere private is refused with a reason instead of failing on
   * every event.
   *
   * ⚠ A COURTESY, NOT THE CONTROL. DNS can change after this answers; the
   * control is the same check at delivery, in deliver.ts. A hostname that does
   * not resolve YET is accepted - customers register before they deploy.
   */
  vet?: (host: string) => Promise<EgressVerdict>
}

export function webhookEndpointStore(
  db: Database,
  secrets: SecretBox,
  opts: WebhookEndpointStoreOptions = {},
): WebhookEndpointStore {
  return {
    async create(tenantId, input) {
      // ⚠ THE URL IS CHECKED BEFORE IT IS STORED, NOT BEFORE IT IS FETCHED.
      // Validating at delivery time would mean a customer can register anything
      // and only find out it is refused when the first event silently fails -
      // and it would put the check in the worker, where a bug is a live SSRF
      // rather than a 422.
      const verdict = checkEndpointUrl(input.url)
      if (!verdict.ok) return { status: "rejected" as const, reason: verdict.reason }

      if (opts.vet) {
        const egress = await opts.vet(new URL(input.url).hostname)
        if (!egress.ok && egress.kind === "blocked") {
          return {
            status: "rejected" as const,
            reason: `\`url\` must point at a public host: ${egress.reason}.`,
          }
        }
      }

      const key = generateKey(input.signature_scheme ?? "hmac_sha256")

      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(webhookEndpoints)
          .values({
            tenantId,
            url: input.url,
            description: input.description ?? null,
            events: input.events as never,
            secretCiphertext: secrets.seal(key.secret),
            signatureScheme: key.scheme,
            publicKey: key.publicKey,
            rateLimit: input.rate_limit ?? null,
          })
          .returning(COLUMNS)

        return {
          status: "created" as const,
          endpoint: { ...present(row!), secret: shown(key) },
        }
      })
    },

    async list(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select(COLUMNS)
          .from(webhookEndpoints)
          .orderBy(desc(webhookEndpoints.createdAt))
        return rows.map((r) => present(r))
      })
    },

    async remove(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const deleted = await tx
          .delete(webhookEndpoints)
          .where(eq(webhookEndpoints.id, id))
          .returning({ id: webhookEndpoints.id })
        return deleted.length > 0
      })
    },

    async rotateSecret(tenantId, id, previous, scheme) {
      return withTenant(db, tenantId, async (tx) => {
        // ⚠ LOCKED, because the retiring list is read, extended and written
        // back. Two rotations racing would otherwise each keep one old key and
        // drop the other's.
        const [current] = await tx
          .select({
            secretCiphertext: webhookEndpoints.secretCiphertext,
            signatureScheme: webhookEndpoints.signatureScheme,
            retiringSecrets: webhookEndpoints.retiringSecrets,
          })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, id))
          .for("update")
        if (!current) return { status: "not_found" as const }

        const now = new Date()
        const plan = planRotation(
          { ciphertext: current.secretCiphertext, scheme: current.signatureScheme },
          current.retiringSecrets,
          previous,
          now,
        )
        if (!plan.ok) return { status: "rejected" as const, reason: plan.reason }

        const key = generateKey(scheme ?? current.signatureScheme)
        const [row] = await tx
          .update(webhookEndpoints)
          .set({
            secretCiphertext: secrets.seal(key.secret),
            signatureScheme: key.scheme,
            publicKey: key.publicKey,
            retiringSecrets: plan.retiring,
            updatedAt: now,
            // ⚠ ROTATION RE-ENABLES AND CLEARS THE FAILURE COUNT. A customer
            // rotating a secret is a customer who has just fixed their receiver;
            // leaving it disabled would mean the fix appears not to work.
            enabled: true,
            failingSince: null,
            disabledAt: null,
            disabledReason: null,
          })
          .where(eq(webhookEndpoints.id, id))
          .returning(COLUMNS)

        return {
          status: "rotated" as const,
          endpoint: { ...present(row!, now), secret: shown(key) },
        }
      })
    },

    async revokePreviousSecrets(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .update(webhookEndpoints)
          .set({ retiringSecrets: [], updatedAt: new Date() })
          .where(eq(webhookEndpoints.id, id))
          .returning(COLUMNS)
        return row ? present(row) : null
      })
    },
  }
}
