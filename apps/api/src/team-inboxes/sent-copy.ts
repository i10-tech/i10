import { JmapAsError } from "../mail/jmap-as.js"
import type { TeamMail } from "../mail/team-mail.js"

/**
 * The server-side Sent copy for team inboxes.
 *
 * When a member sends as `support@`, their client saves the message in the
 * MEMBER's Sent and nowhere else, so the rest of the team never sees the reply.
 * Stalwart has no setting for a copy (an open feature request, "Server-side copy
 * sent items for group mailboxes"). This pass makes one: it finds what each
 * member sent as the team address and copies it into the team's own Sent.
 *
 * ⚠ AN API PASS OVER JMAP, NOT A SIEVE SCRIPT, AND THE REASONS ARE STRUCTURAL.
 *   - The only script that runs on a submission is the system script at
 *     `MtaStageData`. It runs with no account, so it has no mailbox to `fileinto`;
 *     `redirect :copy` to the group address would deliver the reply to the
 *     group's INBOX, as if it had arrived. A per-member user script runs on
 *     delivery, not on submission, and bakes a mailbox id into every member's
 *     script - the "add a member is a three-step dance" the feature request
 *     describes.
 *   - An MTA hook at DATA would receive the whole message (up to 40 MB) as JSON
 *     for every authenticated send; the RCPT-stage hook we run (B5) is body-less
 *     on purpose. And a copy made at submission time races the client's own
 *     "save to Sent", which happens afterwards.
 *   - A pass over the members' Sent folders needs no Stalwart configuration at
 *     all, works for every client (IMAP APPEND, JMAP, SMTP + "save sent"), and is
 *     idempotent, so a missed run is repaired by the next.
 *
 * ⚠ IT IS EVENTUALLY CONSISTENT, AND SAYS SO. A reply reaches the team's Sent
 * when the next pass runs (the CronJob's schedule), not when it is sent. A member
 * removed from the team before a pass runs takes their last unsent-to-Sent
 * replies with them: their folder is no longer read.
 *
 * ⚠ IDEMPOTENT BY MESSAGE-ID, RECORDED AFTER THE COPY. The ledger is written
 * after Stalwart confirms, so a crash between the two copies the message again
 * next time - a duplicate in Sent - rather than losing it. The CronJob does not
 * overlap itself, and Stalwart answers `alreadyExists` for a message the team's
 * Sent already holds, which `team-mail.ts` counts as copied.
 *
 * ⚠ THE PASS FAILS CLOSED. A team whose Stalwart account does not exist yet (no
 * member has signed in) is skipped; one whose account does not carry the expected
 * name or address is an error. Nothing is ever written to an account the registry
 * did not confirm - see `mail/jmap-as.ts`.
 */

/** Every team inbox, with the mailboxes the directory serves as its members. */
export interface SentCopyStore {
  teams(): Promise<{ name: string; address: string; members: { address: string }[] }[]>
  /** Which of these Message-IDs are already recorded for the team. */
  copied(name: string, messageIds: string[]): Promise<Set<string>>
  record(name: string, messageIds: string[]): Promise<void>
}

export interface SentCopyDeps {
  store: SentCopyStore
  mail: TeamMail
  now?: () => Date
  /**
   * How far back each pass looks. Longer than the schedule, so a few missed runs
   * lose nothing; the ledger makes the overlap free.
   */
  lookbackMs?: number
  log: { error: (o: object, m: string) => void }
}

export interface SentCopyResult {
  teams: number
  copied: number
  /** Teams or members that failed for a reason other than "not signed in yet". */
  failed: number
}

/** A day: ten times the five-minute schedule, and a cheap query. */
export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000

const isNoAccount = (error: unknown) =>
  error instanceof JmapAsError && error.code === "no_account"

export async function copyTeamSent(deps: SentCopyDeps): Promise<SentCopyResult> {
  const now = (deps.now ?? (() => new Date()))()
  const since = new Date(now.getTime() - (deps.lookbackMs ?? DEFAULT_LOOKBACK_MS))
  const result: SentCopyResult = { teams: 0, copied: 0, failed: 0 }

  for (const team of await deps.store.teams()) {
    result.teams += 1
    const group = { address: team.address, name: team.name }

    for (const member of team.members) {
      try {
        const sent = await deps.mail.sentAs(member, group, since)
        const seen = await deps.store.copied(
          team.name,
          sent.map((m) => m.messageId),
        )
        // One Message-ID once, even if two members' folders somehow both hold it.
        const fresh = [
          ...new Map(
            sent.filter((m) => !seen.has(m.messageId)).map((m) => [m.messageId, m]),
          ).values(),
        ]
        if (fresh.length === 0) continue

        const done = await deps.mail.copyToSent(group, member, fresh)
        await deps.store.record(team.name, done)
        result.copied += done.length
      } catch (error) {
        // ⚠ "NOT SIGNED IN YET" IS NOT A FAILURE: Stalwart makes an account the
        // first time somebody uses it, and until then there is nothing to read
        // (the member) or nowhere to write (the team).
        if (isNoAccount(error)) continue
        result.failed += 1
        deps.log.error(
          { err: String(error), team: team.address, member: member.address },
          "could not copy a team inbox's sent mail",
        )
      }
    }
  }

  return result
}
