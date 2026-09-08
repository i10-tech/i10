import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm"
import { withTenant, type Database } from "../db/client.js"
import { apiKeys } from "../db/core.js"
import { hashKey, mintKey, type KeyLookup, type KeyRow, type Mode } from "./api-key.js"

/**
 * Reading and writing API keys.
 *
 * ⚠ THE LOOKUP IS THE ONE OPERATION THAT CANNOT USE `withTenant`, AND THAT IS
 * NOT AN OPTIMISATION. `core.api_keys` carries `tenant_isolation`, which reads
 * `current_setting('app.tenant_id')` strictly — but verification runs to
 * DISCOVER the tenant, so at that moment there is none to set. Issued through an
 * ordinary connection the query does not return the wrong row; it raises
 * `unrecognized configuration parameter` on the first request after any deploy.
 * `core.resolve_api_key` is the definer function that answers it, exactly as the
 * reconcilers' snapshots do for their own cross-tenant questions.
 *
 * ⚠ EVERYTHING ELSE HERE IS TENANT-SCOPED AND MUST STAY THAT WAY. Listing,
 * revoking and rotating all name a tenant that is already known, so they go
 * through `withTenant` and let row level security be the thing that stops one
 * customer touching another's credentials — rather than a `WHERE` clause
 * somebody can forget.
 */

/** ⚠ Through the definer function. See above. */
export const resolveStatement = (hash: string): SQL => sql`
  select id::text            as id,
         tenant_id::text     as tenant_id,
         scopes,
         mode,
         revoked_at,
         expires_at
    from core.resolve_api_key(${hash})
`

interface ResolveRow {
  id: string
  tenant_id: string
  scopes: string[] | null
  mode: string
  revoked_at: Date | string | null
  expires_at: Date | string | null
}

/**
 * ⚠ COERCED, NOT CAST. postgres.js is documented to map timestamptz to `Date`
 * and has been observed handing back a string for a column beside one it
 * parsed — which is what broke `planRow` on the first real call to
 * `assignments.find()` in production. `new Date` on a `Date` is a copy, so
 * accepting both costs nothing and cannot be wrong in the direction that
 * matters. Same defensiveness as the `minted_at` read in send/accept-db.ts.
 */
const asDate = (v: Date | string | null): Date | null =>
  v === null ? null : v instanceof Date ? v : new Date(v)

export function keyLookup(db: Database): KeyLookup {
  return {
    async byHash(hash) {
      const rows = (await db.execute(resolveStatement(hash))) as unknown as ResolveRow[]
      const row = rows[0]
      if (!row) return null

      return {
        id: row.id,
        tenantId: row.tenant_id,
        scopes: row.scopes ?? [],
        mode: row.mode,
        revokedAt: asDate(row.revoked_at),
        expiresAt: asDate(row.expires_at),
      } satisfies KeyRow
    },
  }
}

export interface KeySummary {
  id: string
  name: string
  prefix: string
  mode: Mode
  scopes: readonly string[]
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
}

export interface CreatedKey extends KeySummary {
  /** ⚠ The only time this is ever returned. Nothing stores it. */
  secret: string
}

export interface CreateInput {
  tenantId: string
  name: string
  mode: Mode
  scopes?: readonly string[]
  createdBy?: string | null
  expiresAt?: Date | null
}

export interface KeyStore {
  create(input: CreateInput): Promise<CreatedKey>
  list(tenantId: string): Promise<KeySummary[]>
  /** The revoked key's `secret_hash`, so the caller can evict its cache entry. */
  revoke(tenantId: string, id: string): Promise<{ secretHash: string } | null>
  rotate(
    tenantId: string,
    id: string,
  ): Promise<{ created: CreatedKey; revokedHash: string } | null>
}

const summaryOf = (row: typeof apiKeys.$inferSelect): KeySummary => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  mode: row.mode === "test" ? "test" : "live",
  scopes: row.scopes,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
})

export function keyStore(db: Database): KeyStore {
  async function insert(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    input: CreateInput,
  ) {
    const minted = mintKey(input.mode)

    const [row] = await tx
      .insert(apiKeys)
      .values({
        tenantId: input.tenantId,
        name: input.name,
        secretHash: minted.secretHash,
        prefix: minted.prefix,
        mode: minted.mode,
        scopes: [...(input.scopes ?? [])],
        createdBy: input.createdBy ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .returning()

    return { minted, row: row! }
  }

  return {
    async create(input) {
      return withTenant(db, input.tenantId, async (tx) => {
        const { minted, row } = await insert(tx, input)
        return { ...summaryOf(row), secret: minted.secret }
      })
    },

    async list(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select()
          .from(apiKeys)
          .where(eq(apiKeys.tenantId, tenantId))
          .orderBy(desc(apiKeys.createdAt))
        return rows.map(summaryOf)
      })
    },

    async revoke(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        // ⚠ `isNull(revokedAt)` MAKES THIS IDEMPOTENT RATHER THAN DESTRUCTIVE.
        // Re-revoking would move the timestamp, rewriting when a credential was
        // withdrawn — which is the one fact an incident review needs to be exact.
        const [row] = await tx
          .update(apiKeys)
          .set({ revokedAt: sql`now()` })
          .where(
            and(
              eq(apiKeys.id, id),
              eq(apiKeys.tenantId, tenantId),
              isNull(apiKeys.revokedAt),
            ),
          )
          .returning({ secretHash: apiKeys.secretHash })

        return row ?? null
      })
    },

    /**
     * ⚠ MINT FIRST, THEN REVOKE, IN ONE TRANSACTION — AND WITH NO OVERLAP. The
     * button exists for the case where a secret has leaked, so leaving the old
     * key alive for a grace period would preserve exactly what the customer is
     * trying to end. Its real value is not the rotation: it is not having to
     * compose a correct replacement by hand, with the right scopes, under
     * pressure.
     *
     * ⚠ AND A ROTATION OF AN ALREADY-REVOKED KEY IS REFUSED, not silently
     * treated as a fresh mint. That would hand back a working credential for a
     * key the customer believes is dead.
     */
    async rotate(tenantId, id) {
      return withTenant(db, tenantId, async (tx) => {
        const [old] = await tx
          .update(apiKeys)
          .set({ revokedAt: sql`now()` })
          .where(
            and(
              eq(apiKeys.id, id),
              eq(apiKeys.tenantId, tenantId),
              isNull(apiKeys.revokedAt),
            ),
          )
          .returning()

        if (!old) return null

        const { minted, row } = await insert(tx, {
          tenantId,
          name: old.name,
          mode: old.mode === "test" ? "test" : "live",
          scopes: old.scopes,
          createdBy: old.createdBy,
          expiresAt: old.expiresAt,
        })

        return {
          created: { ...summaryOf(row), secret: minted.secret },
          revokedHash: old.secretHash,
        }
      })
    },
  }
}

/** Exported for the tests that pin what the lookup asks for. */
export const hashOf = hashKey
