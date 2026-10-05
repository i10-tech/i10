import type {
  CreateWebhookEndpoint,
  UpdateWebhookEndpoint,
  WebhookEndpoint,
  WebhookEndpointStats,
  WebhookEventName,
} from "@repo/contracts"
import { and, desc, eq, sql } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { webhookDeliveries, webhookEndpoints } from "../db/core.js"
import { checkCustomHeaders } from "./headers.js"
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
  get: (tenantId: string, id: string) => Promise<WebhookEndpoint | null>
  update: (
    tenantId: string,
    id: string,
    patch: UpdateWebhookEndpoint,
  ) => Promise<
    | { status: "updated"; endpoint: WebhookEndpoint }
    | { status: "rejected"; reason: string }
    | { status: "not_found" }
  >
  /** Counts over the window from `since` to now. */
  stats: (
    tenantId: string,
    id: string,
    since: Date,
  ) => Promise<WebhookEndpointStats | null>
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
  headers: Record<string, string> | null
  filterDomains: string[] | null
  filterTags: Record<string, string> | null
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
  // ⚠ NAMES ONLY. Header values are usually credentials; they are write-only.
  header_names: Object.keys(row.headers ?? {}).sort(),
  filter_domains: row.filterDomains,
  filter_tags: row.filterTags,
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
  headers: webhookEndpoints.headers,
  filterDomains: webhookEndpoints.filterDomains,
  filterTags: webhookEndpoints.filterTags,
}

/** Domains compared as DNS does: lowercased, without a trailing dot. */
const normaliseDomains = (domains: string[]): string[] =>
  [...new Set(domains.map((d) => d.trim().toLowerCase().replace(/\.$/, "")))].filter(
    Boolean,
  )

/**
 * Checks the options create and update share. Returns the cleaned values, or
 * why they are refused.
 */
function checkOptions(input: {
  headers?: Record<string, string> | null
  filter_domains?: string[] | null
  filter_tags?: Record<string, string> | null
}):
  | {
      ok: true
      headers?: Record<string, string> | null
      filterDomains?: string[] | null
      filterTags?: Record<string, string> | null
    }
  | { ok: false; reason: string } {
  let headers: Record<string, string> | null | undefined = input.headers
  if (headers) {
    const verdict = checkCustomHeaders(headers)
    if (!verdict.ok) return { ok: false, reason: verdict.reason }
    headers = Object.keys(verdict.headers).length > 0 ? verdict.headers : null
  }
  const filterDomains =
    input.filter_domains === undefined || input.filter_domains === null
      ? input.filter_domains
      : normaliseDomains(input.filter_domains)
  if (filterDomains && filterDomains.length === 0) {
    return {
      ok: false,
      reason: "`filter_domains` must name at least one domain, or be null.",
    }
  }
  const filterTags = input.filter_tags
  if (filterTags && Object.keys(filterTags).length === 0) {
    return {
      ok: false,
      reason: "`filter_tags` must name at least one tag, or be null.",
    }
  }
  return {
    ok: true,
    ...(headers !== undefined ? { headers } : {}),
    ...(filterDomains !== undefined ? { filterDomains } : {}),
    ...(filterTags !== undefined ? { filterTags } : {}),
  }
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

      const options = checkOptions(input)
      if (!options.ok) return { status: "rejected" as const, reason: options.reason }

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
            headers: options.headers ?? null,
            filterDomains: options.filterDomains ?? null,
            filterTags: options.filterTags ?? null,
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

    async get(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select(COLUMNS)
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, id))
          .limit(1)
        return row ? present(row) : null
      })
    },

    async update(tenantId, id, patch) {
      // ⚠ A NEW URL GETS THE SAME CHECKS AS A NEW ENDPOINT. An update is the
      // other way to point our worker somewhere, and an unchecked one would be
      // the SSRF the create path refuses.
      if (patch.url !== undefined) {
        const verdict = checkEndpointUrl(patch.url)
        if (!verdict.ok) return { status: "rejected" as const, reason: verdict.reason }
        if (opts.vet) {
          const egress = await opts.vet(new URL(patch.url).hostname)
          if (!egress.ok && egress.kind === "blocked") {
            return {
              status: "rejected" as const,
              reason: `\`url\` must point at a public host: ${egress.reason}.`,
            }
          }
        }
      }
      const options = checkOptions(patch)
      if (!options.ok) return { status: "rejected" as const, reason: options.reason }

      const set: Partial<typeof webhookEndpoints.$inferInsert> = {
        updatedAt: new Date(),
      }
      if (patch.url !== undefined) set.url = patch.url
      if (patch.events !== undefined) set.events = patch.events as never
      if (patch.description !== undefined) set.description = patch.description
      if (patch.rate_limit !== undefined) set.rateLimit = patch.rate_limit
      if (options.headers !== undefined) set.headers = options.headers
      if (options.filterDomains !== undefined) set.filterDomains = options.filterDomains
      if (options.filterTags !== undefined) set.filterTags = options.filterTags
      if (patch.enabled !== undefined) {
        set.enabled = patch.enabled
        // Pausing is the customer's own act and needs no reason; turning one
        // back on starts its failing clock afresh.
        set.disabledAt = patch.enabled ? null : new Date()
        set.disabledReason = patch.enabled ? null : "Paused."
        if (patch.enabled) set.failingSince = null
      }

      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .update(webhookEndpoints)
          .set(set)
          .where(eq(webhookEndpoints.id, id))
          .returning(COLUMNS)
        return row
          ? { status: "updated" as const, endpoint: present(row) }
          : { status: "not_found" as const }
      })
    },

    async stats(tenantId, id, since) {
      return withTenant(db, tenantId, async (tx) => {
        const [endpoint] = await tx
          .select({
            id: webhookEndpoints.id,
            failingSince: webhookEndpoints.failingSince,
          })
          .from(webhookEndpoints)
          .where(eq(webhookEndpoints.id, id))
          .limit(1)
        if (!endpoint) return null
        const [counts] = await tx
          .select({
            delivered: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'delivered')::int`,
            failed: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'failed')::int`,
            pending: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'pending')::int`,
            lastSuccess: sql<Date | null>`max(${webhookDeliveries.deliveredAt})`,
          })
          .from(webhookDeliveries)
          .where(
            and(
              eq(webhookDeliveries.endpointId, id),
              sql`${webhookDeliveries.createdAt} >= ${since.toISOString()}::timestamptz`,
            ),
          )
        const finished = (counts?.delivered ?? 0) + (counts?.failed ?? 0)
        return {
          object: "webhook_endpoint_stats" as const,
          endpoint_id: id,
          since: since.toISOString(),
          delivered: counts?.delivered ?? 0,
          failed: counts?.failed ?? 0,
          pending: counts?.pending ?? 0,
          success_rate: finished > 0 ? (counts!.delivered ?? 0) / finished : null,
          last_success_at: counts?.lastSuccess
            ? new Date(counts.lastSuccess).toISOString()
            : null,
          failing_since: endpoint.failingSince?.toISOString() ?? null,
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
