import {
  JmapAsError,
  type AuthorisedGroup,
  type AuthorisedMailbox,
  type JmapAsClient,
  type JmapResponse,
} from "./jmap-as.js"

/**
 * What a team inbox needs from Stalwart, and every wire detail of it that no
 * probe has yet confirmed.
 *
 * ⚠ THIS FILE IS THE ONE PLACE THE UNPROBED DETAILS LIVE. The JMAP methods are
 * RFC 8620 / 8621 and their shapes are standard; what was NOT known is how the
 * running 1.0.3 behaves when they are driven through the impersonation key
 * against a Group account that an LDAP directory created. Items 1, 2, 6 and 7
 * were probed on prod on 2026-11-06 with a throwaway group; the rest are still
 * questions for the first rollout, and a wrong answer changes this file and
 * `mail/jmap-as.ts` and nothing else:
 *
 *   1. PROBED: THE GROUP ACCOUNT IS CREATED ON FIRST DELIVERY, NAMED BY THE LOCAL
 *      PART. The directory group `probe-team@i10.tech` became the registry Group
 *      `name: "probe-team"`, `emailAddress: "probe-team@i10.tech"`, when the
 *      first message to it arrived - no member sign-in needed. So `jmap-as`
 *      queries groups by local part and picks the exact address, as for users;
 *      two workspaces' `support@` share a name and differ by address.
 *   2. PROBED: MAIL LANDS IN THAT GROUP ACCOUNT, BUT ONLY WITH `emailReceive`. An
 *      auto-created Group has no role, and `Authentication.defaultGroupRoleIds`
 *      was empty, so the first delivery was refused (`security.unauthorized`,
 *      `emailReceive`, then 550). The plan now gives every group the `i10 Group`
 *      role, which grants exactly that; with it, the message was stored in the
 *      group's own mailbox.
 *   3. THAT A MEMBER SEES THE GROUP'S MAIL WITH NOTHING BUT `memberOf`. The docs
 *      say members reach it "as shared folders in IMAP clients, and as a separate
 *      account in JMAP clients". Nothing else is configured here, on purpose:
 *      see `team-inboxes/service.ts` for why group membership and not per-mailbox
 *      ACLs.
 *   4. HOW LONG A REMOVED MEMBER KEEPS ACCESS. config/README.md records that the
 *      server caches an account's permission set (`accessToken`) and a reload
 *      did not clear it. Removal here is immediate in the directory; the
 *      server's cache decides when it takes effect. Measure it, and if it is
 *      minutes, say so wherever removal is promised.
 *   5. THAT A MEMBER MAY SEND AS THE GROUP. Stalwart issue #485 says members can
 *      submit `From: group@`; whether that needs an Identity, and whether
 *      `MtaStageAuth.mustMatchSender` (default true) allows `MAIL FROM:` the
 *      group address for an LDAP-sourced member, is untested.
 *   6. PROBED: THE IMPERSONATION KEY MAY `Email/copy` BETWEEN TWO ACCOUNTS. A copy
 *      from a member's Sent into the group's `Sent Items` (role `sent`) was
 *      created with the B6 key and the `Email*` grant alone.
 *   7. PROBED: `Email/query` ACCEPTS `inMailbox` WITH `from` AND `after`, and
 *      `Email/get` returns `messageId` (a list, per RFC 8621).
 *   8. THAT DESTROYING A GROUP ACCOUNT (`x:Account/set` destroy) DELETES ITS MAIL
 *      AND THAT IT IS NOT RE-CREATED while a member still lists it in
 *      `memberOf`. `deleteTeamInbox` destroys first and removes the directory
 *      rows second for that reason.
 *   9. SIEVE IS NOT AN OPTION FOR THE SENT COPY, AND THIS IS DESIGN, NOT A PROBE.
 *      The only script that runs on a submission is the system script at
 *      `MtaStageData`; it has no account to `fileinto`, and `redirect :copy` to
 *      the group address would put the reply in the group's INBOX. See
 *      `team-inboxes/sent-copy.ts`.
 */

/**
 * What the directory calls a team inbox, and what the registry is asked for.
 *
 * ⚠ THE WHOLE ADDRESS, LOWERCASED. A local part alone would give `support@a.com`
 * and `support@b.com` the same group, and a member of one would then read the
 * other's mail.
 */
export const teamGroupName = (address: string): string => address.trim().toLowerCase()

/** One message a member sent as the team address, as the member's account holds it. */
export interface SentMessage {
  /** The JMAP email id in the MEMBER's account. */
  emailId: string
  /** The `Message-ID` header, without angle brackets. The ledger's key. */
  messageId: string
}

export interface TeamMail {
  /** What this member sent as the team address since `since`, newest first. */
  sentAs(
    member: AuthorisedMailbox,
    team: AuthorisedGroup,
    since: Date,
  ): Promise<SentMessage[]>

  /** Copies the messages into the team's Sent; returns the Message-IDs now there. */
  copyToSent(
    team: AuthorisedGroup,
    member: AuthorisedMailbox,
    messages: readonly SentMessage[],
  ): Promise<string[]>

  /** Destroys the team's account. `false` when the server has none yet. */
  destroy(team: AuthorisedGroup): Promise<boolean>
}

const MAX_PER_PASS = 100

const answer = (
  responses: JmapResponse[],
  callId: string,
  method: string,
): Record<string, unknown> => {
  const found = responses.find(([, , id]) => id === callId)
  if (!found || found[0] !== method) {
    throw new JmapAsError("stalwart", `stalwart gave no ${method} answer`)
  }
  return found[1]
}

const sentMailboxId = (result: Record<string, unknown>): string => {
  const list = Array.isArray(result.list)
    ? (result.list as Record<string, unknown>[])
    : []
  const sent = list.find((m) => m.role === "sent")
  if (typeof sent?.id !== "string") {
    throw new JmapAsError("stalwart", "the account has no Sent mailbox")
  }
  return sent.id
}

export function teamMail(client: JmapAsClient): TeamMail {
  return {
    async sentAs(member, team, since) {
      const [boxes] = await client.call(member, [
        ["Mailbox/get", { properties: ["id", "role"] }, "m"],
      ])
      const inMailbox = sentMailboxId(boxes![1])

      const responses = await client.call(member, [
        [
          "Email/query",
          {
            filter: { inMailbox, from: team.address, after: since.toISOString() },
            sort: [{ property: "receivedAt", isAscending: false }],
            limit: MAX_PER_PASS,
          },
          "q",
        ],
        [
          "Email/get",
          {
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["id", "messageId"],
          },
          "g",
        ],
      ])

      const list = answer(responses, "g", "Email/get").list
      const emails = Array.isArray(list) ? (list as Record<string, unknown>[]) : []

      return emails.flatMap((email) => {
        const messageId = Array.isArray(email.messageId) ? email.messageId[0] : null
        // ⚠ NO MESSAGE-ID, NO COPY. It is the ledger's key; without it the same
        // message would be copied again on every pass.
        return typeof email.id === "string" &&
          typeof messageId === "string" &&
          messageId
          ? [{ emailId: email.id, messageId }]
          : []
      })
    },

    async copyToSent(team, member, messages) {
      if (messages.length === 0) return []

      const [boxes] = await client.callAsGroup(team, [
        ["Mailbox/get", { properties: ["id", "role"] }, "m"],
      ])
      const sentId = sentMailboxId(boxes![1])

      const keyed = messages.map((message, i) => ({ key: `c${i}`, ...message }))
      const responses = await client.callAsGroup(
        team,
        [
          [
            "Email/copy",
            {
              create: Object.fromEntries(
                keyed.map(({ key, emailId }) => [
                  key,
                  {
                    id: emailId,
                    mailboxIds: { [sentId]: true },
                    keywords: { $seen: true },
                  },
                ]),
              ),
            },
            "c",
          ],
        ],
        { from: member },
      )

      const result = answer(responses, "c", "Email/copy")
      const created = (result.created ?? {}) as Record<string, unknown>
      const notCreated = (result.notCreated ?? {}) as Record<string, { type?: string }>

      // ⚠ `alreadyExists` IS A COPY THAT HAPPENED: the message is in the team's
      // Sent already, from a pass whose ledger write was lost. Anything else is a
      // failure the pass must report, not a message to skip quietly.
      const done: string[] = []
      for (const { key, messageId } of keyed) {
        if (key in created || notCreated[key]?.type === "alreadyExists") {
          done.push(messageId)
        } else if (key in notCreated) {
          throw new JmapAsError(
            "stalwart",
            `stalwart would not copy a message into ${team.address}: ${String(notCreated[key]?.type ?? "unknown")}`,
          )
        }
      }
      return done
    },

    destroy: (team) => client.destroyGroup(team),
  }
}
