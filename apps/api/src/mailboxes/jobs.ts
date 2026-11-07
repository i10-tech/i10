import { createHmac, timingSafeEqual } from "node:crypto"
import { and, desc, eq, isNotNull, lt, or, sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { withTenant } from "../db/client.js"
import { accounts } from "../db/schema.js"
import { mailboxJobs, tenants } from "../db/core.js"
import type { ObjectStore } from "../content/object-store.js"

/**
 * Who may move a mailbox's mail, and where the jobs that do it are kept (#385).
 *
 * Who can request an export or an import:
 *   - the mailbox's owner (`accounts.clerk_user_id` is the session's user)
 *   - the workspace's owner (`tenants.owner_clerk_user_id`)
 *   - a workspace admin (`members:manage` in our roles table, #335)
 * Any other member of the workspace is refused: a mailbox is its owner's mail,
 * and a colleague's seat on the workspace is not a right to read it.
 */

export interface MailboxAccessResult {
  allowed: boolean
  tenantId?: string
  reason?: "not_found" | "forbidden"
}

export interface AdminChecker {
  /** Whether this person holds `members:manage` in the workspace: our roles table. */
  isAdmin(userId: string, tenantId: string): Promise<boolean>
}

export interface MailboxAccessFacts {
  mailboxOwner: string
  tenantId: string
  tenantOwner: string | null
  clerkOrgId: string | null
}

export async function loadAccessFacts(
  db: Database,
  address: string,
): Promise<MailboxAccessFacts | null> {
  const [account] = await db
    .select({ owner: accounts.clerkUserId, tenantId: accounts.tenantId })
    .from(accounts)
    .where(eq(accounts.email, address.trim().toLowerCase()))
    .limit(1)
  if (!account?.tenantId) return null

  const [tenant] = await db
    .select({ owner: tenants.ownerClerkUserId, orgId: tenants.clerkOrgId })
    .from(tenants)
    .where(eq(tenants.id, account.tenantId))
    .limit(1)

  return {
    mailboxOwner: account.owner,
    tenantId: account.tenantId,
    tenantOwner: tenant?.owner ?? null,
    clerkOrgId: tenant?.orgId ?? null,
  }
}

/** The decision itself, apart from the lookups, so it can be tested alone. */
export async function decideAccess(
  facts: MailboxAccessFacts | null,
  userId: string,
  adminChecker?: AdminChecker,
): Promise<MailboxAccessResult> {
  if (!facts) return { allowed: false, reason: "not_found" }
  const { tenantId } = facts

  if (facts.mailboxOwner === userId) return { allowed: true, tenantId }
  if (facts.tenantOwner === userId) return { allowed: true, tenantId }
  if (
    facts.clerkOrgId &&
    adminChecker &&
    (await adminChecker.isAdmin(userId, tenantId))
  ) {
    return { allowed: true, tenantId }
  }
  return { allowed: false, reason: "forbidden", tenantId }
}

export async function canAccessMailbox(
  db: Database,
  userId: string,
  address: string,
  adminChecker?: AdminChecker,
): Promise<MailboxAccessResult> {
  return decideAccess(await loadAccessFacts(db, address), userId, adminChecker)
}

// ── Download links ──────────────────────────────────────────────────────────

/**
 * `<tenant>.<job>.<expires>.<signature>`.
 *
 * ⚠ THE TENANT AND THE JOB ARE BOTH SIGNED, and the route looks the job up under
 * that tenant, so a token for one workspace's job cannot be pointed at another's
 * and a job id on its own opens nothing. The signature is keyed per purpose
 * (`mailbox-download.v1`) so the same secret cannot mint some other kind of
 * token that this would accept.
 */
const sign = (payload: string, secret: string) =>
  createHmac("sha256", secret)
    .update(`mailbox-download.v1.${payload}`)
    .digest("base64url")

export function signDownloadToken(
  link: { tenantId: string; jobId: string },
  expiresAtMs: number,
  secret: string,
): string {
  const payload = `${link.tenantId}.${link.jobId}.${expiresAtMs}`
  return `${payload}.${sign(payload, secret)}`
}

export function verifyDownloadToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): { tenantId: string; jobId: string } | null {
  const parts = token.split(".")
  if (parts.length !== 4) return null
  const [tenantId, jobId, expires, signature] = parts as [
    string,
    string,
    string,
    string,
  ]

  const given = Buffer.from(signature, "base64url")
  const expected = Buffer.from(
    sign(`${tenantId}.${jobId}.${expires}`, secret),
    "base64url",
  )
  // ⚠ CONSTANT TIME. The lengths are public (a SHA-256 digest), so comparing
  // them first leaks nothing; the bytes are what must not be compared early.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  const expiresAt = Number(expires)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowMs) return null
  return { tenantId, jobId }
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export type MailboxJobRow = typeof mailboxJobs.$inferSelect
export type MailboxJobType = "export" | "import"
export type MailboxJobStatus =
  "awaiting_upload" | "pending" | "running" | "completed" | "failed"

export type MailboxJobPatch = Partial<
  Pick<
    MailboxJobRow,
    | "status"
    | "totalMessages"
    | "processedMessages"
    | "totalFolders"
    | "processedFolders"
    | "objectKey"
    | "error"
    | "errorCode"
    | "completedAt"
    | "expiresAt"
  >
>

/** Everything the routes and the worker ask of the table, so both can be faked. */
export interface MailboxJobStore {
  insert(input: {
    tenantId: string
    mailboxAddress: string
    type: MailboxJobType
    requestedBy: string
    status: MailboxJobStatus
    objectKey?: string
  }): Promise<MailboxJobRow>
  get(tenantId: string, jobId: string): Promise<MailboxJobRow | null>
  latest(
    tenantId: string,
    address: string,
    type: MailboxJobType,
  ): Promise<MailboxJobRow | null>
  update(
    tenantId: string,
    jobId: string,
    patch: MailboxJobPatch,
  ): Promise<MailboxJobRow | null>
  /** Jobs whose archive in the content store is past its keep. */
  withExpiredObject(tenantId: string, now: Date): Promise<MailboxJobRow[]>
}

/** An import's archive is kept this long after the job last moved, then goes. */
const IMPORT_ARCHIVE_KEEP_MS = 24 * 60 * 60 * 1000

export function mailboxJobStore(db: Database): MailboxJobStore {
  return {
    async insert(input) {
      const [row] = await withTenant(db, input.tenantId, (tx) =>
        tx
          .insert(mailboxJobs)
          .values({ ...input, mailboxAddress: input.mailboxAddress.toLowerCase() })
          .returning(),
      )
      return row!
    },

    async get(tenantId, jobId) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(mailboxJobs)
          .where(and(eq(mailboxJobs.id, jobId), eq(mailboxJobs.tenantId, tenantId)))
          .limit(1),
      )
      return row ?? null
    },

    async latest(tenantId, address, type) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(mailboxJobs)
          .where(
            and(
              eq(mailboxJobs.tenantId, tenantId),
              eq(mailboxJobs.mailboxAddress, address.toLowerCase()),
              eq(mailboxJobs.type, type),
            ),
          )
          .orderBy(desc(mailboxJobs.createdAt))
          .limit(1),
      )
      return row ?? null
    },

    async update(tenantId, jobId, patch) {
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx
          .update(mailboxJobs)
          .set({ ...patch, updatedAt: sql`now()` })
          .where(and(eq(mailboxJobs.id, jobId), eq(mailboxJobs.tenantId, tenantId)))
          .returning(),
      )
      return row ?? null
    },

    async withExpiredObject(tenantId, now) {
      return withTenant(db, tenantId, (tx) =>
        tx
          .select()
          .from(mailboxJobs)
          .where(
            and(
              eq(mailboxJobs.tenantId, tenantId),
              isNotNull(mailboxJobs.objectKey),
              or(
                and(eq(mailboxJobs.type, "export"), lt(mailboxJobs.expiresAt, now)),
                and(
                  eq(mailboxJobs.type, "import"),
                  lt(
                    mailboxJobs.updatedAt,
                    new Date(now.getTime() - IMPORT_ARCHIVE_KEEP_MS),
                  ),
                ),
              ),
            ),
          )
          .limit(50),
      )
    },
  }
}

/**
 * Deletes the archives in the content store that nobody is going to use again:
 * an export past its seven days, and an import's upload a day after the job last
 * moved (it is deleted when the job ends, so this is for the ones that never
 * started).
 *
 * ⚠ ONE WORKSPACE AT A TIME, because `mailbox_jobs` is under row-level security
 * and finding every workspace's expired jobs at once needs a SECURITY DEFINER
 * function like the ones `retention.ts` reads its due lists from. That function
 * is a migration of its own, so until it exists this runs for the workspace of
 * each job that starts (see `migration.ts`) and nothing sweeps a workspace that
 * never exports again. Hooking it into `retention.ts` is the follow-up.
 */
export async function sweepMailboxArchives(
  jobs: MailboxJobStore,
  store: ObjectStore,
  tenantId: string,
  now = new Date(),
): Promise<number> {
  const expired = await jobs.withExpiredObject(tenantId, now)
  for (const job of expired) {
    // Idempotent, so a sweep that died between the two steps simply runs again.
    await store.delete(job.objectKey!)
    await jobs.update(tenantId, job.id, { objectKey: null })
  }
  return expired.length
}
