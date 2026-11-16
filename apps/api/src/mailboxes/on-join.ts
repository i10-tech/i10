import type { MailboxCreationMode } from "@repo/contracts"
import type { ClerkUser } from "../projection/clerk-user.js"
import type { MailboxIdentity, MailboxProvisioning } from "./provision.js"

/**
 * `on_join`: a person who joins a workspace gets a mailbox without asking.
 *
 * ⚠ BEST EFFORT, AND IT CANNOT FAIL THE JOIN. This runs from the Clerk
 * `organizationMembership.created` webhook, after our roles table has taken the
 * membership (routes/webhooks.ts order). The person is already in; what is left is
 * a convenience, so every failure here is logged and swallowed. The cost of that
 * choice is that a transient failure is not retried by Svix - an admin can create
 * the mailbox by hand, which is the same route this is a shortcut for.
 *
 * ⚠ IT GOES THROUGH `provisioning.create`, THE SAME PATH AS A PERSON'S OWN, so the
 * same checks apply (domain ownership, address taken, one mailbox per person,
 * seats, sign-in precondition) and there is no second INSERT. Idempotent under
 * retries: a redelivery finds the mailbox the first run made and stops.
 *
 * ⚠ ONLY WHERE THE ADDRESS CANNOT BE A GUESS: the workspace hosts exactly one
 * domain, and the local part is the one the person already uses at their primary
 * verified address, normalised. Several domains would need a default rule nobody
 * has chosen; a local part that does not normalise cleanly, or that is taken, is
 * skipped rather than varied (`alice2`, `alice.smith`), because a second guess
 * hands the person an address they did not pick and may already be somebody's.
 */

export interface MailJoinDeps {
  /** The tenant behind a Clerk organization (from a verified webhook). */
  tenantOf(clerkOrgId: string): Promise<string | null>
  mode(tenantId: string): Promise<MailboxCreationMode>
  /** The verified, mailbox-hosting domains of the workspace. */
  hostedDomains(tenantId: string): Promise<string[]>
  identity: Pick<MailboxIdentity, "get">
  provisioning: Pick<MailboxProvisioning, "create" | "current">
  log: {
    info: (o: object, m: string) => void
    warn: (o: object, m: string) => void
  }
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null

/** Longest local part RFC 5321 allows. */
const MAX_LOCAL_PART = 64

/** Letters and digits, with single `.`, `_` or `-` between them. */
const SAFE_LOCAL_PART = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/

/**
 * The local part to offer, or `null` when there is any doubt.
 *
 * Lowercased, with a `+tag` dropped. Nothing else is repaired: a name that is not
 * already plain ASCII words (quoted, non-Latin, consecutive dots) is skipped.
 */
export function deriveLocalPart(email: string): string | null {
  const at = email.lastIndexOf("@")
  if (at < 1) return null
  const local = email.slice(0, at).trim().toLowerCase().split("+")[0]!
  if (local.length === 0 || local.length > MAX_LOCAL_PART) return null
  return SAFE_LOCAL_PART.test(local) ? local : null
}

/** The person's primary address, when Clerk has verified it. */
function primaryAddress(user: ClerkUser): string | null {
  const primary = (user.email_addresses ?? []).find(
    (e) =>
      e.id === user.primary_email_address_id && e.verification?.status === "verified",
  )
  return primary ? primary.email_address.trim().toLowerCase() : null
}

export async function onMailJoinEvent(
  d: MailJoinDeps,
  type: string,
  data: unknown,
): Promise<string | null> {
  if (type !== "organizationMembership.created") return null
  const orgId = text(record(record(data)?.organization)?.id)
  const userId = text(record(record(data)?.public_user_data)?.user_id)
  if (!orgId || !userId) return null

  try {
    const tenantId = await d.tenantOf(orgId)
    if (!tenantId) return null
    // Not this workspace's setting: say nothing, which is most joins.
    if ((await d.mode(tenantId)) !== "on_join") return null

    const skip = (reason: string, extra: object = {}) => {
      d.log.info({ tenantId, userId, reason, ...extra }, "no mailbox made on join")
      return `mailbox:skipped:${reason}`
    }

    const domains = await d.hostedDomains(tenantId)
    if (domains.length !== 1)
      return skip(domains.length === 0 ? "no_domain" : "many_domains")

    if (await d.provisioning.current(userId)) return skip("has_mailbox")

    const person = await d.identity.get(userId)
    if (!person) return skip("no_user")
    const primary = primaryAddress(person.user)
    if (!primary) return skip("no_primary_address")
    const local = deriveLocalPart(primary)
    if (!local) return skip("local_part")

    const outcome = await d.provisioning.create(
      userId,
      { address: `${local}@${domains[0]}` },
      { tenantId },
    )
    if (outcome.status === "created") {
      d.log.info({ tenantId, userId }, "made a mailbox for a new member")
      return "mailbox:created"
    }
    return skip(outcome.status)
  } catch (err) {
    d.log.warn({ orgId, userId, err: String(err) }, "could not make a mailbox on join")
    return "mailbox:error"
  }
}
