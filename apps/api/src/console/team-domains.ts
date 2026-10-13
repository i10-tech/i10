import type { TxtLookup } from "../domains/ownership.js"
import { NO_TENANT } from "../middleware/tenant.js"
import type { JoinRule } from "../db/core.js"
import {
  cleanRules,
  isFreeMail,
  isHostname,
  matchAccess,
  normalizeName,
  ruleFor,
  within,
} from "./access-rules.js"
import type { AccessDomainRow, JoinStore } from "./join.js"

/**
 * Team access domains (#326): who may find and join a workspace by email
 * address, with off, suggest or auto-join per address pattern. Run by us
 * since 2026-10-13; only adding (or removing) the member goes to Clerk.
 *
 * ⚠ THIS REPLACED CLERK'S "VERIFIED ORGANIZATION DOMAINS", WHICH IS NOT ON OUR
 * CLERK PLAN FOR PRODUCTION (it answered 403 `organization_domain_enrollment_
 * mode_not_enabled`). The proof was always ours anyway: a domain verified on
 * /domains, or the access-only TXT record, is DNS - a stronger proof than
 * Clerk's code emailed to one address at it.
 *
 * ⚠ EVERY DECISION IS MADE FROM THE PERSON'S VERIFIED ADDRESSES, read from
 * Clerk by the caller, and from the workspace's own rows. Nothing about who
 * someone is or what they may join is ever taken from a request body.
 *
 * ⚠ THE REMOVED AND BLOCK LISTS ARE CHECKED EVERYWHERE A PERSON COULD GET IN:
 * the suggestion, the request, the instant Join and auto-join at sign-up.
 * Removed: may only ask. Blocked: nothing at all.
 */

export type AddOutcome = "added" | "full"

export interface TeamDomainDeps {
  /** Names of this workspace's domains verified on /domains. */
  verified(tenantId: string): Promise<string[]>
  /** Whether this person holds `permission` in the organization. */
  can(userId: string, orgId: string, permission: string): Promise<boolean>
  store: JoinStore
  /** Clerk organizations this person already belongs to. */
  memberOrgIds(userId: string): Promise<string[]>
  /** Each organization's public face, for a suggestion card. */
  describe(
    orgIds: string[],
  ): Promise<Record<string, { name: string; imageUrl: string | null }>>
  /**
   * Adds a person to the organization with a role. `full` when Clerk refuses
   * with `organization_membership_quota_exceeded`; already a member is `added`.
   */
  addMember(orgId: string, userId: string, role: string): Promise<AddOutcome>
  /** Takes a member out of the organization. Already gone is done. */
  removeMember?(orgId: string, userId: string): Promise<void>
  /** A Clerk invitation; the email goes out through our own auth mail. */
  invite?(
    orgId: string,
    inviterUserId: string,
    email: string,
    role: string,
    tenantId: string,
  ): Promise<void>
  /** A person's VERIFIED addresses, from Clerk. */
  emailsOf?(userId: string): Promise<string[]>
  /** Whether the organization is somebody's Personal workspace (#325). */
  isPersonal?(orgId: string): Promise<boolean>
  /** For the access-only TXT proof. */
  txt?: TxtLookup
  /**
   * Member limits per plan (#327). Absent, Clerk's own refusal is the only
   * check, as it was in #326.
   */
  seats?: SeatChecks
}

/**
 * ⚠ ASKED BEFORE EVERY SEAT USE, NOT ONLY CLERK. Clerk's maximum is never set
 * below the members a downgraded workspace already holds, so the plan's limit
 * is ours to enforce - and an expired invitation still holds a spot in Clerk
 * until it is revoked, which `beforeSeatUse` does first. See console/members.ts.
 */
export interface SeatChecks {
  beforeSeatUse(tenantId: string, orgId: string): Promise<{ full: boolean }>
  /** "A spot opened up, you're in" (or "you're in") to an accepted request. */
  accepted?(input: {
    tenantId: string
    requestId: string
    email: string
    waited: boolean
  }): Promise<void>
}

/** Changing access domains needs the same permission Clerk's domains did. */
export const MANAGE_DOMAINS = "org:sys_domains:manage"
/** Answering requests and removing people needs the one that manages members. */
export const MANAGE_MEMBERS = "org:sys_memberships:manage"

const DEFAULT_ROLE = "org:member"

type Admin = { tenantId: string; userId: string; orgId?: string }

async function gate(
  d: TeamDomainDeps,
  input: Admin,
  permission: string,
): Promise<"ok" | "no_org" | "forbidden"> {
  if (!input.orgId) return "no_org"
  if (!(await d.can(input.userId, input.orgId, permission))) return "forbidden"
  return "ok"
}

// ── Access domains ────────────────────────────────────────────────────────────

/** The Team page's Access block: entries, and /domains names to suggest. */
export async function listAccess(d: TeamDomainDeps, tenantId: string) {
  const [rows, verified, dismissed] = await Promise.all([
    d.store.accessDomains(tenantId),
    d.verified(tenantId),
    d.store.dismissed(tenantId),
  ])
  const added = new Set(rows.map((r) => r.name))
  /*
   * ⚠ EXACTLY THE NAMES VERIFIED ON /domains, NEVER A PARENT. A workspace
   * that verified `notifications.pslhq.app` is offered that, not `pslhq.app`
   * - nothing proved the parent. Free-mail names never appear.
   */
  const verifiedNames = [...new Set(verified.map(normalizeName))].filter(
    (n) => !isFreeMail(n),
  )
  return {
    domains: rows,
    verified: verifiedNames,
    suggested: verifiedNames.filter((n) => !added.has(n) && !dismissed.includes(n)),
  }
}

export type AddAccessOutcome =
  | { outcome: "ok"; id: string; existed: boolean }
  | {
      outcome:
        "no_org" | "forbidden" | "invalid" | "free_mail" | "not_verified" | "personal"
    }

export async function addAccessDomain(
  d: TeamDomainDeps,
  input: Admin & { name: string; source: "domains" | "txt" },
): Promise<AddAccessOutcome> {
  const allowed = await gate(d, input, MANAGE_DOMAINS)
  if (allowed !== "ok") return { outcome: allowed }
  const name = normalizeName(input.name)
  if (!isHostname(name)) return { outcome: "invalid" }
  // ⚠ BEFORE ANY PROOF: no proof makes gmail.com somebody's team.
  if (isFreeMail(name)) return { outcome: "free_mail" }
  // A Personal workspace has one member and never takes anybody in.
  if (await d.isPersonal?.(input.orgId!)) return { outcome: "personal" }
  if (input.source === "domains") {
    const verified = (await d.verified(input.tenantId)).map(normalizeName)
    if (!verified.includes(name)) return { outcome: "not_verified" }
  }
  const made = await d.store.addAccessDomain(input.tenantId, {
    name,
    clerkOrgId: input.orgId!,
    source: input.source,
  })
  if (made.outcome === "not_verified" || !made.id) return { outcome: "not_verified" }
  return { outcome: "ok", id: made.id, existed: made.outcome === "exists" }
}

export async function verifyAccessDomain(
  d: TeamDomainDeps,
  input: Admin & { id: string },
): Promise<"proven" | "absent" | "unreachable" | "missing" | "no_org" | "forbidden"> {
  const allowed = await gate(d, input, MANAGE_DOMAINS)
  if (allowed !== "ok") return allowed
  if (!d.txt) return "unreachable"
  return d.store.verifyTxt(input.tenantId, input.id, d.txt)
}

export async function removeAccessDomain(
  d: TeamDomainDeps,
  input: Admin & { id: string },
): Promise<"ok" | "missing" | "no_org" | "forbidden"> {
  const allowed = await gate(d, input, MANAGE_DOMAINS)
  if (allowed !== "ok") return allowed
  return (await d.store.removeAccessDomain(input.tenantId, input.id)) ? "ok" : "missing"
}

export type RulesOutcome =
  | { outcome: "ok"; rules: JoinRule[] }
  | { outcome: "invalid"; error: string }
  | { outcome: "missing" | "no_org" | "forbidden" }

/**
 * Replaces one access domain's rules.
 *
 * ⚠ VALIDATED AGAINST THE DOMAIN THEY BELONG TO, HERE, NOT IN THE BROWSER: a
 * pattern may not reach above the proven name, and the role must be one
 * Clerk could give. Admin is allowed - the console warns before it is sent.
 */
export async function setAccessRules(
  d: TeamDomainDeps,
  input: Admin & { id: string; rules: unknown },
): Promise<RulesOutcome> {
  const allowed = await gate(d, input, MANAGE_DOMAINS)
  if (allowed !== "ok") return { outcome: allowed }
  const row = (await d.store.accessDomains(input.tenantId)).find(
    (r) => r.id === input.id,
  )
  if (!row) return { outcome: "missing" }
  const cleaned = cleanRules(input.rules, row.name)
  if (!cleaned.ok) return { outcome: "invalid", error: cleaned.error }
  const saved = await d.store.setRules(input.tenantId, input.id, cleaned.rules)
  return saved ? { outcome: "ok", rules: cleaned.rules } : { outcome: "missing" }
}

export async function dismissAccessSuggestion(
  d: TeamDomainDeps,
  input: Admin & { name: string },
): Promise<"ok" | "no_org" | "forbidden"> {
  const allowed = await gate(d, input, MANAGE_DOMAINS)
  if (allowed !== "ok") return allowed
  await d.store.dismiss(input.tenantId, input.name)
  return "ok"
}

// ── What a person is offered ──────────────────────────────────────────────────

export interface Offer {
  tenantId: string
  clerkOrgId: string
  email: string
  pattern: string
  /**
   * `auto` lets them Join at once; `suggest` lets them ask. A removed
   * person's `auto` is `suggest`: they may only ask.
   */
  mode: "suggest" | "auto"
  role: string
  requested: boolean
  removed: boolean
  /** Already recorded as joined (and so not auto-joined again). */
  joined: boolean
}

/**
 * Every workspace whose rules let this person in, by their verified
 * addresses, less blocked addresses and workspaces in `exceptOrgIds`.
 */
export async function offersFor(
  d: TeamDomainDeps,
  input: {
    currentTenantId: string
    userId: string
    emails: string[]
    exceptOrgIds: string[]
  },
): Promise<Offer[]> {
  const found = await d.store.accessFor(input)
  const matches = matchAccess(found.domains, input.emails).filter(
    (m) => !input.exceptOrgIds.includes(m.clerkOrgId),
  )
  const offers: Offer[] = []
  for (const m of matches) {
    // ⚠ READ UNDER THE MATCHED WORKSPACE'S TENANT: its lists are its own.
    const lists = await d.store.excluded(m.tenantId, input.emails)
    const kinds = input.emails.map((e) => lists.get(e.trim().toLowerCase()))
    if (kinds.includes("blocked")) continue
    const removed = kinds.includes("removed")
    offers.push({
      tenantId: m.tenantId,
      clerkOrgId: m.clerkOrgId,
      email: m.email,
      pattern: m.pattern,
      mode: removed ? "suggest" : m.mode,
      role: m.role,
      requested: found.requested.has(m.tenantId),
      removed,
      joined: found.joined.has(m.tenantId),
    })
  }
  return offers
}

/** Asks to join; only a workspace that offers this person anything. */
export async function requestToJoin(
  d: TeamDomainDeps,
  input: {
    currentTenantId: string
    userId: string
    emails: string[]
    tenantId: string
  },
): Promise<"created" | "exists" | "not_suggested"> {
  const offer = (await offersFor(d, { ...input, exceptOrgIds: [] })).find(
    (o) => o.tenantId === input.tenantId,
  )
  if (!offer) return "not_suggested"
  return d.store.fileRequest(offer.tenantId, {
    userId: input.userId,
    email: offer.email,
    via: offer.pattern,
    full: false,
  })
}

/**
 * Join, at once, a workspace whose rule for this person is auto-join - the
 * existing-user half of auto-join.
 *
 * ⚠ A FULL WORKSPACE TURNS IT INTO A REQUEST, NOT AN ERROR: the person is told
 * "Acme is full right now. We've asked its admins to add you." and the admins
 * see it under Requests.
 */
export async function joinNow(
  d: TeamDomainDeps,
  input: {
    currentTenantId: string
    userId: string
    emails: string[]
    tenantId: string
  },
): Promise<{ outcome: "joined"; orgId: string } | { outcome: "full" | "not_offered" }> {
  const memberOf = await d.memberOrgIds(input.userId)
  const offer = (await offersFor(d, { ...input, exceptOrgIds: memberOf })).find(
    (o) => o.tenantId === input.tenantId,
  )
  if (!offer || offer.mode !== "auto") return { outcome: "not_offered" }
  return admit(d, input.userId, offer, "join")
}

async function admit(
  d: TeamDomainDeps,
  userId: string,
  offer: Offer,
  how: "auto" | "join",
): Promise<{ outcome: "joined"; orgId: string } | { outcome: "full" }> {
  const room = await d.seats?.beforeSeatUse(offer.tenantId, offer.clerkOrgId)
  const added = room?.full
    ? "full"
    : await d.addMember(offer.clerkOrgId, userId, offer.role)
  if (added === "full") {
    await d.store.fileRequest(offer.tenantId, {
      userId,
      email: offer.email,
      via: offer.pattern,
      full: true,
    })
    return { outcome: "full" }
  }
  await d.store.recordJoin(offer.tenantId, {
    userId,
    email: offer.email,
    how,
    via: offer.pattern,
  })
  return { outcome: "joined", orgId: offer.clerkOrgId }
}

export interface AutoJoined {
  tenantId: string
  orgId: string
  outcome: "joined" | "full"
}

/**
 * Auto-join at sign-up: every workspace whose rule for one of the new
 * person's VERIFIED addresses is auto-join.
 *
 * ⚠ IDEMPOTENT, BECAUSE IT RUNS MORE THAN ONCE. Svix redelivers `user.created`
 * and onboarding asks again in case the webhook is late. A workspace already
 * recorded as joined is skipped; Clerk's "already a member" is `added`; and an
 * open request is not filed twice. A person who left again is not pulled back.
 */
export async function autoJoin(
  d: TeamDomainDeps,
  input: { currentTenantId: string; userId: string; emails: string[] },
): Promise<AutoJoined[]> {
  const memberOf = await d.memberOrgIds(input.userId)
  const offers = await offersFor(d, { ...input, exceptOrgIds: memberOf })
  const done: AutoJoined[] = []
  for (const offer of offers) {
    if (offer.mode !== "auto" || offer.joined) continue
    // A full workspace already holds their request; asking Clerk again adds nothing.
    if (offer.requested) continue
    const result = await admit(d, input.userId, offer, "auto")
    done.push({
      tenantId: offer.tenantId,
      orgId: offer.clerkOrgId,
      outcome: result.outcome,
    })
  }
  return done
}

// ── Requests ──────────────────────────────────────────────────────────────────

export type AnswerOutcome = "ok" | "full" | "forbidden" | "missing" | "no_org"

/**
 * Accepting adds the member in Clerk FIRST and marks the request answered
 * after, so a Clerk failure (or a full workspace) leaves the request open to
 * try again rather than "accepted" with nobody added.
 *
 * ⚠ THE ROLE IS THE RULE'S, AS IT STANDS NOW, for the address that asked;
 * member when no rule covers it any more. Approving clears every address of
 * theirs from the removed list - and from the block list, since an admin chose
 * to let them in.
 */
export async function answerJoinRequest(
  d: TeamDomainDeps,
  input: Admin & { id: string; accept: boolean; block?: boolean },
): Promise<AnswerOutcome> {
  const allowed = await gate(d, input, MANAGE_MEMBERS)
  if (allowed !== "ok") return allowed
  const request = (await d.store.pending(input.tenantId)).find((r) => r.id === input.id)
  if (!request) return "missing"
  if (input.accept) {
    const room = await d.seats?.beforeSeatUse(input.tenantId, input.orgId!)
    if (room?.full) return "full"
    const role = roleFor(await d.store.accessDomains(input.tenantId), request.email)
    const added = await d.addMember(input.orgId!, request.user_id, role)
    if (added === "full") return "full"
  }
  const answered = await d.store.answer(input.tenantId, input.id, input.accept)
  if (!answered) return "missing"
  /*
   * ⚠ EVERY ADDRESS OF THEIRS, NOT ONLY THE ONE THAT ASKED. Removing somebody
   * lists all their verified addresses, so letting them back in has to clear
   * all of them for their record to be clean - and blocking has to cover all
   * of them, as "Remove and block" does, or another address walks round it.
   */
  const addresses = [
    request.email,
    ...((await d.emailsOf?.(request.user_id).catch(() => [])) ?? []),
  ]
  if (input.accept) {
    await d.store.allow(input.tenantId, addresses)
    await d.store.recordJoin(input.tenantId, {
      userId: request.user_id,
      email: request.email,
      how: "request",
      via: request.via,
    })
    /*
     * ⚠ ACCEPT AND NOTIFY IS ONE FLOW (#327). Everybody accepted is told they
     * are in; somebody who waited for room is told a spot opened up. The
     * membership is already made, so a mail failure is not the admin's error.
     */
    await d.seats
      ?.accepted?.({
        tenantId: input.tenantId,
        requestId: request.id,
        email: request.email,
        waited: request.full,
      })
      .catch(() => {})
  } else if (input.block) {
    await d.store.exclude(input.tenantId, addresses, "blocked")
  }
  return "ok"
}

/**
 * The role the most specific rule gives this address, or member.
 *
 * ⚠ WHATEVER THE RULE'S MODE: a request answered after its rule went `off`
 * still gets the role that rule names.
 */
export function roleFor(rows: AccessDomainRow[], email: string): string {
  const host = email.split("@")[1]?.toLowerCase() ?? ""
  const rules = rows
    .filter((r) => r.status === "verified" && within(host, r.name))
    .flatMap((r) => r.rules)
  return ruleFor(rules, host)?.role ?? DEFAULT_ROLE
}

// ── Removed and blocked ───────────────────────────────────────────────────────

/**
 * Removes a member, recording every verified address of theirs on the
 * removed list - or the block list.
 *
 * ⚠ LISTED BEFORE CLERK IS ASKED. The other order leaves a window - or, if
 * this process dies between the two, a permanent state - where they are out
 * of the workspace and free to auto-join straight back in.
 */
export async function removeTeamMember(
  d: TeamDomainDeps,
  input: Admin & { memberUserId: string; block: boolean },
): Promise<"ok" | "self" | "no_org" | "forbidden" | "unavailable"> {
  const allowed = await gate(d, input, MANAGE_MEMBERS)
  if (allowed !== "ok") return allowed
  if (input.memberUserId === input.userId) return "self"
  if (!d.removeMember || !d.emailsOf) return "unavailable"
  const recorded = (await d.store.joins(input.tenantId)).find(
    (j) => j.user_id === input.memberUserId,
  )
  const emails = [
    ...(await d.emailsOf(input.memberUserId)),
    ...(recorded ? [recorded.email] : []),
  ]
  await d.store.exclude(input.tenantId, emails, input.block ? "blocked" : "removed")
  await d.removeMember(input.orgId!, input.memberUserId)
  await d.store.forgetJoin(input.tenantId, input.memberUserId)
  return "ok"
}

/**
 * Takes an address off the removed or block list: "Allow", or "Allow and
 * invite" with a Clerk invitation (whose email is ours, through the auth
 * mail path - Clerk's own sending is off).
 */
export async function allowAddress(
  d: TeamDomainDeps,
  input: Admin & { email: string; invite: boolean; role?: string },
): Promise<"ok" | "no_org" | "forbidden" | "unavailable"> {
  const allowed = await gate(d, input, MANAGE_MEMBERS)
  if (allowed !== "ok") return allowed
  if (input.invite && !d.invite) return "unavailable"
  const email = input.email.trim().toLowerCase()
  await d.store.allow(input.tenantId, [email])
  if (input.invite)
    await d.invite!(
      input.orgId!,
      input.userId,
      email,
      input.role ?? DEFAULT_ROLE,
      input.tenantId,
    )
  return "ok"
}

// ── Sign-up ───────────────────────────────────────────────────────────────────

/**
 * The `user.created` webhook's half of auto-join: the new person's VERIFIED
 * addresses, read from Clerk's payload, and nothing else.
 *
 * ⚠ AN ADDRESS WITH ANY OTHER VERIFICATION STATUS IS IGNORED. Somebody who
 * signs up with `ceo@acme.com` and has not entered the code has typed a
 * string, and a string is not a reason to be added to Acme.
 *
 * ⚠ THROWS ON A CLERK OR DATABASE FAILURE, SO SVIX RETRIES; the whole thing
 * is idempotent (see `autoJoin`). A full workspace is not a failure.
 */
export async function autoJoinFromWebhook(
  d: TeamDomainDeps,
  data: unknown,
): Promise<string | null> {
  const user = data as {
    id?: unknown
    email_addresses?: { email_address?: unknown; verification?: { status?: unknown } }[]
  } | null
  if (!user || typeof user.id !== "string") return null
  const emails = (user.email_addresses ?? []).flatMap((e) =>
    typeof e.email_address === "string" && e.verification?.status === "verified"
      ? [e.email_address.toLowerCase()]
      : [],
  )
  if (emails.length === 0) return null
  const done = await autoJoin(d, {
    currentTenantId: NO_TENANT,
    userId: user.id,
    emails,
  })
  if (done.length === 0) return null
  return done.map((j) => `${j.outcome}:${j.orgId}`).join(",")
}
