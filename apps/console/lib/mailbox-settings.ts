import { formatBytes } from "@/lib/format"
import type { StoragePool } from "@/lib/mailbox-view"

/**
 * What the mailbox settings page says (U0): the three ways mailboxes get
 * created, and what the storage plan means, in words for someone who has never
 * managed email.
 *
 * The routes are `GET`/`PUT /console/mailboxes/creation-mode` and the `pool` of
 * `GET /console/mailboxes`; the modes mirror `mailboxCreationModeSchema` in
 * @repo/contracts, which the console does not depend on.
 */

export type CreationMode = "admins" | "members" | "on_join"

export const CREATION_MODES: readonly {
  value: CreationMode
  label: string
  description: string
}[] = [
  {
    value: "admins",
    label: "Only owners and admins",
    description:
      "Owners and admins create every mailbox. Everyone else asks one of them.",
  },
  {
    value: "members",
    label: "Anyone in the workspace",
    description:
      "People create their own mailbox when they want one. Owners and admins can still create them for others.",
  },
  {
    value: "on_join",
    label: "Automatically when someone joins",
    description:
      "Each new person gets a mailbox the moment they join, and anyone can still create their own.",
  },
]

/** The words for a mode where it is only read, not changed. */
export function creationModeSentence(mode: CreationMode): string {
  switch (mode) {
    case "admins":
      return "Only owners and admins create mailboxes. Ask one of them if you need one."
    case "members":
      return "Anyone in the workspace can create their own mailbox."
    case "on_join":
      return "Everyone gets a mailbox when they join, and anyone can still create their own."
  }
}

/**
 * The caveat on "automatically", or null when there is none.
 *
 * ⚠ IT ONLY HAPPENS WITH EXACTLY ONE HOSTED DOMAIN (apps/api/src/mailboxes/on-join.ts):
 * with several there is no address to pick for someone, so the API creates
 * nothing rather than guessing. Saying so beside the choice stops "automatic"
 * being read as a promise it does not keep.
 */
export function onJoinCaveat(mode: CreationMode, hostedDomains: number): string | null {
  if (mode !== "on_join") return null
  if (hostedDomains === 1) return null
  return hostedDomains === 0
    ? "Nobody gets one automatically until a domain hosts mailboxes."
    : `You host mailboxes on ${hostedDomains} domains, and automatic creation only works with exactly one. Until then people create their own.`
}

/** What the storage overview says about a pool, as a title and a sentence. */
export function storageSummary(pool: StoragePool): { title: string; body: string } {
  if (pool.kind === "pool" && pool.total != null) {
    const left = pool.remaining ?? Math.max(pool.total - pool.allocated, 0)
    return {
      title: "A pool you share out",
      body: `Your plan includes ${formatBytes(pool.total)} of storage for mailboxes. You have given ${formatBytes(pool.allocated)} to mailboxes and have ${formatBytes(left)} left to give.`,
    }
  }
  return {
    title: "Pay as you go",
    body: `Mailboxes are not capped. You are billed for what they actually use, which is ${formatBytes(pool.used)} right now.`,
  }
}

/** The line about mailboxes that have no share yet, or null when every one has. */
export function unallocatedLine(pool: StoragePool): string | null {
  if (pool.unallocated <= 0) return null
  return pool.unallocated === 1
    ? "1 mailbox has no storage set and uses the default quota."
    : `${pool.unallocated} mailboxes have no storage set and use the default quota.`
}
