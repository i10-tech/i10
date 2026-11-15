import { and, desc, eq } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { dnsConnections } from "../db/core.js"
import type { SealContext, Sealer } from "../crypto/sealer.js"
import type { Credential } from "./port.js"

/**
 * The credentials customers have given us for their own DNS.
 *
 * ⚠ THE CREDENTIAL IS SEALED BEFORE IT REACHES A ROW AND IS NEVER RETURNED TO A
 * CLIENT. A DNS write token can rewrite somebody's MX records and take delivery
 * of their mail - every password reset and every login link they receive - which
 * makes it strictly more dangerous than the mailbox it protects. There is no
 * "show my connection" endpoint, for the same reason there is none for a webhook
 * signing secret: such a call is a better target than the database it reads.
 *
 * ⚠ AND `summary()` IS WHAT THE CONSOLE GETS. It carries the provider, the
 * label, the zones we proved reachable and the last error - everything needed to
 * render the state of a connection and nothing that could be used as one.
 */

export interface ConnectionSummary {
  id: string
  provider: string
  label: string | null
  zones: string[]
  lastUsedAt: string | null
  lastError: string | null
  createdAt: string
}

export interface StoredConnection extends ConnectionSummary {
  credential: Credential
}

export interface DnsConnectionStore {
  list(tenantId: string): Promise<ConnectionSummary[]>
  /** ⚠ The only method that opens a credential. Used by the publisher. */
  get(tenantId: string, provider: string): Promise<StoredConnection | null>
  save(input: {
    tenantId: string
    provider: string
    label: string | null
    credential: Credential
    zones: string[]
  }): Promise<ConnectionSummary>
  /**
   * Replaces the stored credential, leaving everything else alone.
   *
   * ⚠ SEPARATE FROM `save` BECAUSE A RENEWAL IS NOT A RECONNECTION. `save`
   * takes the label and the zone list, which a refresh does not have and must
   * not invent - re-listing zones on every token renewal would put a second
   * round trip on the publish path, and passing an empty list would erase the
   * zones the console renders.
   */
  updateCredential(input: {
    tenantId: string
    provider: string
    credential: Credential
  }): Promise<void>

  remove(tenantId: string, provider: string): Promise<boolean>
  /** Records the outcome of a publish, for the console to render. */
  noteUse(input: {
    tenantId: string
    provider: string
    error: string | null
  }): Promise<void>
}

export function dnsConnectionStore(
  db: Database,
  secrets: Sealer,
  log: { error: (o: object, m: string) => void },
): DnsConnectionStore {
  const credentialOf = (tenantId: string, provider: string): SealContext => ({
    purpose: "core.dns_connections.credential_sealed",
    tenantId,
    rowId: provider,
  })

  const summarise = (row: {
    id: string
    provider: string
    label: string | null
    zones: string[]
    lastUsedAt: Date | null
    lastError: string | null
    createdAt: Date
  }): ConnectionSummary => ({
    id: row.id,
    provider: row.provider,
    label: row.label,
    zones: row.zones,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  })

  const COLUMNS = {
    id: dnsConnections.id,
    provider: dnsConnections.provider,
    label: dnsConnections.label,
    zones: dnsConnections.zones,
    lastUsedAt: dnsConnections.lastUsedAt,
    lastError: dnsConnections.lastError,
    createdAt: dnsConnections.createdAt,
  }

  return {
    async list(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select(COLUMNS)
          .from(dnsConnections)
          .where(eq(dnsConnections.tenantId, tenantId))
          .orderBy(desc(dnsConnections.createdAt))
        return rows.map(summarise)
      })
    },

    async get(tenantId, provider) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ ...COLUMNS, credentialSealed: dnsConnections.credentialSealed })
          .from(dnsConnections)
          .where(
            and(
              eq(dnsConnections.tenantId, tenantId),
              eq(dnsConnections.provider, provider),
            ),
          )
          .limit(1)
        if (!row) return null

        /*
         * ⚠ A CREDENTIAL THAT WILL NOT OPEN IS TREATED AS ABSENT, NOT AS A
         * CRASH, AND IT IS LOGGED AS AN ERROR. The customer sees "you are not
         * connected, reconnect", which is the right outcome for them, and
         * throwing would fail every page that lists connections. But it means
         * a key was dropped from `SEAL_KEYS` too early or the row was tampered
         * with, which is ours to know about and never theirs to discover.
         */
        let credential: Credential
        try {
          credential = JSON.parse(
            secrets.open(credentialOf(tenantId, provider), row.credentialSealed),
          ) as Credential
        } catch (err) {
          log.error(
            { err, tenantId, provider },
            "DNS credential does not open - the connection reads as disconnected",
          )
          return null
        }

        return { ...summarise(row), credential }
      })
    },

    async updateCredential({ tenantId, provider, credential }) {
      const sealed = secrets.seal(
        credentialOf(tenantId, provider),
        JSON.stringify(credential),
      )
      await withTenant(db, tenantId, async (tx) =>
        tx
          .update(dnsConnections)
          .set({ credentialSealed: sealed })
          .where(
            and(
              eq(dnsConnections.tenantId, tenantId),
              eq(dnsConnections.provider, provider),
            ),
          ),
      )
    },

    async save({ tenantId, provider, label, credential, zones }) {
      const sealed = secrets.seal(
        credentialOf(tenantId, provider),
        JSON.stringify(credential),
      )

      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(dnsConnections)
          .values({
            tenantId,
            provider,
            label,
            credentialSealed: sealed,
            zones,
          })
          /*
           * ⚠ RE-AUTHORISING REPLACES RATHER THAN APPENDS, and it clears the
           * last error. Two live tokens for one account is two things to
           * revoke and only one that anybody remembers; a stale error beside a
           * fresh credential is a red badge on a connection that now works.
           */
          .onConflictDoUpdate({
            target: [dnsConnections.tenantId, dnsConnections.provider],
            set: {
              label,
              credentialSealed: sealed,
              zones,
              lastError: null,
              updatedAt: new Date(),
            },
          })
          .returning(COLUMNS)

        return summarise(row!)
      })
    },

    async remove(tenantId, provider) {
      return withTenant(db, tenantId, async (tx) => {
        const removed = await tx
          .delete(dnsConnections)
          .where(
            and(
              eq(dnsConnections.tenantId, tenantId),
              eq(dnsConnections.provider, provider),
            ),
          )
          .returning({ id: dnsConnections.id })
        return removed.length > 0
      })
    },

    async noteUse({ tenantId, provider, error }) {
      await withTenant(db, tenantId, async (tx) => {
        await tx
          .update(dnsConnections)
          .set({ lastUsedAt: new Date(), lastError: error, updatedAt: new Date() })
          .where(
            and(
              eq(dnsConnections.tenantId, tenantId),
              eq(dnsConnections.provider, provider),
            ),
          )
      })
    },
  }
}
