/**
 * Turning a Clerk user into a mailbox row.
 *
 * This is the write side of the projection that `services/authd` reads. authd
 * answers Stalwart's directory searches from it, so what this module decides is
 * exactly what Stalwart will treat as a local recipient.
 */

export interface ClerkEmailAddress {
  id: string
  email_address: string
  verification?: { status?: string | null } | null
}

export interface ClerkUser {
  id: string
  email_addresses?: ClerkEmailAddress[] | null
  primary_email_address_id?: string | null
  first_name?: string | null
  last_name?: string | null
  updated_at?: number | null
}

export interface Mailbox {
  clerkUserId: string
  /** The primary mailbox address, lowercased. */
  email: string
  /** Additional hosted addresses for the same person, lowercased and sorted. */
  aliases: string[]
  displayName: string
  clerkUpdatedAt: Date | null
}

/**
 * Projects a Clerk user to a mailbox, or null when they should not have one.
 *
 * ⚠ THE HOSTED-DOMAIN FILTER IS A SAFETY GUARD, NOT A TIDINESS ONE. Most i10
 * users sign up with an address we do not host — a Gmail, a work address.
 * Projecting that address would put it in the directory, and Stalwart would
 * then accept inbound mail for `someone@gmail.com` as a LOCAL RECIPIENT:
 * silently swallowing mail addressed to a domain that is not ours. Only
 * addresses in domains i10 actually hosts may ever become rows.
 *
 * Unverified addresses are excluded too. i10 assigns mailbox addresses during
 * onboarding and can create them already verified, so anything unverified is
 * either mid-flow or a claim the user has not proven.
 *
 * Returning null is meaningful: the caller deletes any existing row, so a user
 * who gives up their i10 address stops being a recipient.
 */
export function projectUser(
  user: ClerkUser,
  hostedDomains: readonly string[],
): Mailbox | null {
  const hosted = new Set(hostedDomains.map((d) => d.toLowerCase().replace(/^@/, "")))

  const addresses = (user.email_addresses ?? [])
    .filter((e) => e.verification?.status === "verified")
    .map((e) => ({ id: e.id, address: e.email_address.trim().toLowerCase() }))
    .filter(
      (e) =>
        e.address.includes("@") &&
        hosted.has(e.address.slice(e.address.lastIndexOf("@") + 1)),
    )

  if (addresses.length === 0) return null

  // Clerk's primary wins when it is hosted. Otherwise pick deterministically —
  // an arbitrary choice would make the mailbox address flap between webhook
  // deliveries, and that address is the user's identity.
  const sorted = [...addresses].sort((a, b) => a.address.localeCompare(b.address))
  const primary =
    sorted.find((e) => e.id === user.primary_email_address_id) ?? sorted[0]!

  return {
    clerkUserId: user.id,
    email: primary.address,
    aliases: sorted.filter((e) => e.address !== primary.address).map((e) => e.address),
    displayName: [user.first_name, user.last_name].filter(Boolean).join(" ").trim(),
    clerkUpdatedAt: toDate(user.updated_at),
  }
}

/**
 * Clerk timestamps are milliseconds since the epoch.
 *
 * There is no password-specific timestamp in Clerk's user object, so
 * `updated_at` is what authd serves to Stalwart as `pwdChangeTime`. It errs in
 * the safe direction — it moves on any profile change, invalidating cached
 * tokens more often than strictly needed rather than less. It doubles as the
 * ordering guard for out-of-order webhook delivery.
 */
function toDate(ms: number | null | undefined): Date | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null
  return new Date(ms)
}
