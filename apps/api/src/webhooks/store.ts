import type {
  CreateWebhookEndpoint,
  WebhookEndpoint,
  WebhookEventName,
} from "@repo/contracts"
import { desc, eq } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { webhookEndpoints } from "../db/core.js"
import { checkEndpointUrl } from "./endpoints.js"
import { generateSecret, type SecretBox } from "./signing.js"

/**
 * The customer-facing half of webhooks: registering endpoints.
 *
 * ⚠ THE SECRET IS GENERATED HERE, RETURNED ONCE, AND STORED SEALED. It is the
 * only thing that distinguishes our POST from anyone else's, so it is created
 * where it can be handed back in the same response and never held anywhere it
 * could be read again.
 */

export interface WebhookEndpointStore {
  create: (
    tenantId: string,
    input: CreateWebhookEndpoint,
  ) => Promise<
    | { status: "created"; endpoint: WebhookEndpoint & { secret: string } }
    | { status: "rejected"; reason: string }
  >
  list: (tenantId: string) => Promise<WebhookEndpoint[]>
  remove: (tenantId: string, id: string) => Promise<boolean>
  rotateSecret: (
    tenantId: string,
    id: string,
  ) => Promise<(WebhookEndpoint & { secret: string }) | null>
}

type Row = {
  id: string
  url: string
  events: string[]
  description: string | null
  enabled: boolean
  createdAt: Date
}

const present = (row: Row): WebhookEndpoint => ({
  object: "webhook_endpoint",
  id: row.id,
  url: row.url,
  events: row.events as WebhookEventName[],
  description: row.description,
  enabled: row.enabled,
  created_at: row.createdAt.toISOString(),
})

const COLUMNS = {
  id: webhookEndpoints.id,
  url: webhookEndpoints.url,
  events: webhookEndpoints.events,
  description: webhookEndpoints.description,
  enabled: webhookEndpoints.enabled,
  createdAt: webhookEndpoints.createdAt,
}

export function webhookEndpointStore(
  db: Database,
  secrets: SecretBox,
): WebhookEndpointStore {
  return {
    async create(tenantId, input) {
      // ⚠ THE URL IS CHECKED BEFORE IT IS STORED, NOT BEFORE IT IS FETCHED.
      // Validating at delivery time would mean a customer can register anything
      // and only find out it is refused when the first event silently fails —
      // and it would put the check in the worker, where a bug is a live SSRF
      // rather than a 422.
      const verdict = checkEndpointUrl(input.url)
      if (!verdict.ok) return { status: "rejected" as const, reason: verdict.reason }

      const secret = generateSecret()

      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(webhookEndpoints)
          .values({
            tenantId,
            url: input.url,
            description: input.description ?? null,
            events: input.events as never,
            secretCiphertext: secrets.seal(secret),
          })
          .returning(COLUMNS)

        return {
          status: "created" as const,
          endpoint: { ...present(row!), secret },
        }
      })
    },

    async list(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select(COLUMNS)
          .from(webhookEndpoints)
          .orderBy(desc(webhookEndpoints.createdAt))
        return rows.map(present)
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

    async rotateSecret(tenantId, id) {
      const secret = generateSecret()

      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .update(webhookEndpoints)
          .set({
            secretCiphertext: secrets.seal(secret),
            updatedAt: new Date(),
            // ⚠ ROTATION RE-ENABLES AND CLEARS THE FAILURE COUNT. A customer
            // rotating a secret is a customer who has just fixed their receiver;
            // leaving it disabled would mean the fix appears not to work.
            enabled: true,
            consecutiveFailures: 0,
            disabledAt: null,
          })
          .where(eq(webhookEndpoints.id, id))
          .returning(COLUMNS)

        return row ? { ...present(row), secret } : null
      })
    },
  }
}
