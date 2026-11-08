import { DEFAULT_ROLE, type JoinRole } from "../console/roles.js"
import type { Assertion, Connection } from "./model.js"
import type {
  ClerkIdentity,
  ClerkUserSnapshot,
  GroupRoleRule,
  IdentityStore,
} from "./ports.js"

/**
 * Just-in-time provisioning and group-to-role rules (#341, sso.md 2.6).
 *
 *   - JIT: a first sign-in through an active connection, for an address on one
 *     of its live domains that the IdP vouches for and that no Clerk account
 *     holds, creates the person: Clerk user, identity, managed account,
 *     membership. Off by default, per connection.
 *   - Group rules: the IdP's `groups` against the connection's rules, first
 *     match by precedence, member otherwise; applied at every sign-in.
 *   - Profile: the IdP's given and family name, to Clerk, when they changed.
 *
 * The bridge (bridge.ts) runs all three; what is here is the part that can be
 * decided without it, and the one creation that must be locked.
 */

/**
 * Whether a first sign-in through this connection may create the person.
 *
 * ⚠ ACTIVE ONLY. A test run on a `testing` connection says what JIT WOULD do
 * (bridge.ts) and never creates anybody.
 *
 * "With SCIM on, JIT can be switched off" (sso.md 2.6) is the admin turning
 * `jit_enabled` off; a directory does not switch it by itself.
 */
export function jitAllowed(
  connection: Pick<Connection, "status" | "jitEnabled">,
): boolean {
  return connection.status === "active" && connection.jitEnabled
}

export interface MappedRole {
  role: JoinRole
  /** The rule that gave it; null for the default. */
  rule: GroupRoleRule | null
}

/**
 * The role the IdP's groups give: the first rule, by precedence then age,
 * whose group the assertion names; the default (member) otherwise.
 *
 * ⚠ EXACT VALUES. A group is matched as the IdP sends it - an Okta name, an
 * Entra object id - with no case folding or trimming, so a look-alike group
 * somebody created in the IdP is not taken for the real one.
 */
export function roleFromGroups(
  rules: readonly GroupRoleRule[],
  groups: readonly string[] | undefined,
): MappedRole {
  const held = new Set((groups ?? []).filter((g) => typeof g === "string"))
  const ordered = [...rules].sort(
    (a, b) => a.precedence - b.precedence || a.id.localeCompare(b.id),
  )
  const rule = ordered.find((r) => held.has(r.groupValue)) ?? null
  return { role: rule?.role ?? DEFAULT_ROLE, rule }
}

const hasControl = (value: string) =>
  [...value].some((ch) => {
    const code = ch.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })

/** A person's name as the IdP sent it, if it is one we will store. */
export function readName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const name = value.trim()
  if (!name || name.length > 256 || hasControl(name)) return null
  return name
}

/**
 * What profile sync changes in Clerk: the names the IdP asserts that differ
 * from Clerk's, or null when nothing does.
 *
 * ⚠ ONLY WHAT WAS ASSERTED. An IdP that sends no family name leaves Clerk's
 * alone; it never blanks a name.
 */
export function profileChanges(
  user: Pick<ClerkUserSnapshot, "firstName" | "lastName">,
  assertion: Pick<Assertion, "givenName" | "familyName">,
): { firstName?: string; lastName?: string } | null {
  const changes: { firstName?: string; lastName?: string } = {}
  const first = readName(assertion.givenName)
  const last = readName(assertion.familyName)
  if (first && first !== user.firstName) changes.firstName = first
  if (last && last !== user.lastName) changes.lastName = last
  return Object.keys(changes).length > 0 ? changes : null
}

// ── Console input ────────────────────────────────────────────────────────

/** The most group-to-role rules one connection may hold. */
export const MAX_GROUP_RULES = 100

/** A group value from a request: 1 to 256 characters, no control characters. */
export function readGroupValue(value: unknown): string | null {
  if (typeof value !== "string") return null
  const group = value.trim()
  if (!group || group.length > 256 || hasControl(group)) return null
  return group
}

/** A precedence from a request: a whole number from 0 to 10000. */
export function readPrecedence(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 10_000
    ? value
    : null
}

// ── Creating the person ──────────────────────────────────────────────────

export type Provisioned =
  /** Made now: the Clerk user and its identity link. */
  | { outcome: "created"; userId: string; identityId: string }
  /** A sign-in that got here first linked this subject; use its link. */
  | { outcome: "linked"; userId: string; identityId: string }
  /** The address belongs to a Clerk account already: resolve again (claim path). */
  | { outcome: "exists" }
  /** Clerk needs something the IdP did not send (a name): refused, nothing made. */
  | { outcome: "incomplete" }

/**
 * Creates the person for a first sign-in, under the JIT lock.
 *
 * ⚠ TWO FIRST SIGN-INS MUST NOT MAKE TWO CLERK USERS, AND TWO NETS SEE TO IT.
 * Ours: one lock per address (`provisionLocked`), inside which
 * the subject's link and Clerk's holders are asked AGAIN - the second sign-in
 * waits, then finds the first one's link. Clerk's: an address is unique in an
 * instance, so a creation racing something outside our lock (the person
 * signing up by hand at that moment) is answered `exists`, and the bridge
 * resolves again, finding that account on the claim path.
 *
 * ⚠ THE LINK IS WRITTEN IN THE LOCK'S TRANSACTION, so whoever waits sees it
 * the moment the lock is theirs. If the link fails after Clerk made the user,
 * the transaction rolls back and the user is left unlinked; the next sign-in
 * finds them as a verified holder of the address and claims them.
 */
export async function provision(
  d: { store: IdentityStore; clerk: ClerkIdentity },
  input: {
    tenantId: string
    connection: Connection
    assertion: Assertion
    email: string
  },
): Promise<Provisioned> {
  return d.store.provisionLocked(
    input.tenantId,
    { connectionId: input.connection.id, email: input.email },
    async (lock) => {
      const linked = await lock.identityBySubject(input.assertion.subject)
      if (linked)
        return { outcome: "linked", userId: linked.clerkUserId, identityId: linked.id }
      if ((await d.clerk.usersByEmail(input.email)).length > 0)
        return { outcome: "exists" }
      const made = await d.clerk.createUser({
        email: input.email,
        firstName: readName(input.assertion.givenName),
        lastName: readName(input.assertion.familyName),
      })
      if (made.outcome !== "created") return { outcome: made.outcome }
      const identity = await lock.link({
        subject: input.assertion.subject,
        clerkUserId: made.userId,
        email: input.email,
      })
      return { outcome: "created", userId: made.userId, identityId: identity.id }
    },
  )
}
