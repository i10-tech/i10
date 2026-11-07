import type {
  MailboxJobPatch,
  MailboxJobRow,
  MailboxJobStore,
} from "../../src/mailboxes/jobs.js"

/**
 * `core.mailbox_jobs` in memory, with the one rule the table enforces that the
 * tests lean on: a row is only visible under its own tenant, as row-level
 * security makes it.
 */
export function memoryJobStore(clock: () => Date = () => new Date()) {
  const rows = new Map<string, MailboxJobRow>()
  const updates: { jobId: string; patch: MailboxJobPatch }[] = []

  const store: MailboxJobStore & {
    rows: Map<string, MailboxJobRow>
    updates: typeof updates
  } = {
    rows,
    updates,
    async insert(input) {
      const now = clock()
      const row: MailboxJobRow = {
        id: crypto.randomUUID(),
        tenantId: input.tenantId,
        mailboxAddress: input.mailboxAddress.toLowerCase(),
        type: input.type,
        status: input.status,
        totalMessages: 0,
        processedMessages: 0,
        totalFolders: 0,
        processedFolders: 0,
        objectKey: input.objectKey ?? null,
        error: null,
        errorCode: null,
        requestedBy: input.requestedBy,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        expiresAt: null,
      }
      rows.set(row.id, row)
      return row
    },
    async get(tenantId, jobId) {
      const row = rows.get(jobId)
      return row && row.tenantId === tenantId ? { ...row } : null
    },
    async latest(tenantId, address, type) {
      const found = [...rows.values()]
        .filter(
          (r) =>
            r.tenantId === tenantId &&
            r.mailboxAddress === address.toLowerCase() &&
            r.type === type,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      return found[0] ? { ...found[0] } : null
    },
    async update(tenantId, jobId, patch) {
      const row = rows.get(jobId)
      if (!row || row.tenantId !== tenantId) return null
      updates.push({ jobId, patch })
      const next = { ...row, ...patch, updatedAt: clock() }
      rows.set(jobId, next)
      return { ...next }
    },
    async withExpiredObject(tenantId, now) {
      return [...rows.values()].filter(
        (r) =>
          r.tenantId === tenantId &&
          r.objectKey !== null &&
          ((r.type === "export" && r.expiresAt !== null && r.expiresAt < now) ||
            (r.type === "import" &&
              r.updatedAt.getTime() < now.getTime() - 24 * 3600_000)),
      )
    },
  }
  return store
}
