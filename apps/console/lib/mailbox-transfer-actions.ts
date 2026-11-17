"use server"

import { api, ApiRequestError } from "@/lib/api"
import type { MailboxJob } from "@/lib/mailbox-transfer"
import { run } from "@/lib/sso-run"

/**
 * Every call the mailbox page's export and import make (U7), as server actions
 * for the reason lib/actions.ts gives: the session token never reaches the
 * browser, and a refusal comes back as a value carrying the API's own words.
 *
 * ⚠ THE ROUTES ARE `/mailboxes/:address/...`, NOT `/console/...`. They are the
 * API's session routes that exist outside the console too, and each checks for
 * itself that the caller is the mailbox's owner, the workspace's owner or an
 * admin (apps/api/src/routes/mailbox-migration.ts). `api()` allows exactly that
 * prefix and nothing else besides `/console/*` (lib/api-path.ts).
 *
 * ⚠ NONE OF THEM REVALIDATES A PATH, AND THAT IS DELIBERATE. The section holds
 * its jobs in client state and takes each new state from an action's own answer
 * or from its poll. A revalidation would re-render the page behind an open
 * dialog and, mid-upload, replace the file picker's state with the server's.
 * The one re-render the section asks for itself is `router.refresh()` when the
 * mailbox is being deleted, so the deletion banner (which reads the same export)
 * does not say something the section has already moved past.
 *
 * ⚠ THE STEP-UP IS ASKED BY THE CALLER BEFORE `startMailboxExport` AND
 * `reserveMailboxImport`, NOT HERE: the API refuses a stale session with Clerk's
 * hint and the dialog lives in the browser. `startMailboxImport` is not behind
 * one on purpose: it can only run the job a fresh reservation made, and an
 * upload can take hours.
 */

const base = (address: string) => `/mailboxes/${encodeURIComponent(address)}`

/** Queues an export, or returns the one already running. */
export async function startMailboxExport(address: string) {
  return run(() => api<MailboxJob>(`${base(address)}/export`, { method: "POST" }))
}

/** Asks for a place to upload an archive of `size` bytes to. */
export async function reserveMailboxImport(address: string, size: number) {
  return run(() =>
    api<MailboxJob>(`${base(address)}/import`, { method: "POST", body: { size } }),
  )
}

/** Says the archive has reached storage, and queues the import. */
export async function startMailboxImport(address: string, jobId: string) {
  return run(() =>
    api<MailboxJob>(`${base(address)}/import/${encodeURIComponent(jobId)}/start`, {
      method: "POST",
    }),
  )
}

/**
 * The latest job of a kind, or null when there has never been one (the API's
 * 404 for this is "nothing here", not a failure).
 */
async function latest(address: string, kind: "export" | "import") {
  return run(async () => {
    try {
      return await api<MailboxJob>(`${base(address)}/${kind}`)
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) return null
      throw error
    }
  })
}

export async function readMailboxExport(address: string) {
  return latest(address, "export")
}

export async function readMailboxImport(address: string) {
  return latest(address, "import")
}
