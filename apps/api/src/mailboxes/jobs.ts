import { and, desc, eq, sql } from "drizzle-orm"
import type { Database } from "../db/client.js"
import { withTenant } from "../db/client.js"
import { accounts } from "../db/schema.js"
import { mailboxJobs, tenants } from "../db/core.js"
import type { TokenKeys } from "../crypto/token-keys.js"
import type { MailboxJobData } from "../queue/mailbox-queue.js"

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
 * and a job id on its own opens nothing. The MAC is under the `mailbox-download`
 * subkey of `TOKEN_KEYS`, so no other kind of token we sign is accepted here.
 */
export function signDownloadToken(
  link: { tenantId: string; jobId: string },
  expiresAtMs: number,
  keys: TokenKeys,
): string {
  const payload = `${link.tenantId}.${link.jobId}.${expiresAtMs}`
  return `${payload}.${keys.sign("mailbox-download", payload)}`
}

export function verifyDownloadToken(
  token: string,
  keys: TokenKeys,
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
  if (!keys.verify("mailbox-download", `${tenantId}.${jobId}.${expires}`, signature)) {
    return null
  }

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
    | "sealedKey"
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
}

/**
 * Queues an export of the mailbox, or returns the one already running.
 *
 * ⚠ ONE START, TWO CALLERS: the export route and a mailbox's deletion with
 * `export_then_delete` (mailboxes/lifecycle.ts). Both must mean the same thing by
 * "an export is running", or a second click and a deletion would each queue one.
 * The caller has already decided that the person may ask: this is only the queue.
 */
export async function startMailboxExport(
  d: {
    jobs: Pick<MailboxJobStore, "latest" | "insert">
    enqueue: (data: MailboxJobData) => Promise<unknown>
  },
  input: { tenantId: string; address: string; requestedBy: string },
): Promise<MailboxJobRow> {
  const address = input.address.trim().toLowerCase()
  const current = await d.jobs.latest(input.tenantId, address, "export")
  if (current && (current.status === "pending" || current.status === "running")) {
    return current
  }
  const job = await d.jobs.insert({
    tenantId: input.tenantId,
    mailboxAddress: address,
    type: "export",
    requestedBy: input.requestedBy,
    status: "pending",
  })
  await d.enqueue({
    jobId: job.id,
    tenantId: input.tenantId,
    mailboxAddress: address,
    type: "export",
  })
  return job
}

/**
 * How long an import's upload URL works: enough to send LIMITS.maxArchiveBytes
 * on a slow line. The sweep in sweep.ts waits this long before it deletes an
 * upload of a deleted workspace, so no `PUT` can land after it.
 */
export const UPLOAD_TTL_S = 6 * 60 * 60

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
  }
}
