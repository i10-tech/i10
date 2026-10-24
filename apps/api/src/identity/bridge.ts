import type { JoinRole, SyncOutcome } from "../console/roles.js"
import {
  jitAllowed,
  profileChanges,
  provision,
  readName,
  roleFromGroups,
  type MappedRole,
} from "./jit.js"
import { enforceManaged } from "./managed.js"
import {
  ATTEMPT_TTL_MS,
  BIND_WINDOW_MS,
  CLOCK_SKEW_MS,
  HANDOFF_TTL_MS,
  STEP_UP_MAX_AGE_MS,
  emailDomain,
  hashSecret,
  newSecret,
  normaliseEmail,
  onLiveDomain,
  assertionProvesMfa,
  sameHash,
  type Assertion,
  type AttemptPurpose,
  type Connection,
  type ManagedReason,
  type Protocol,
  type Refusal,
} from "./model.js"
import type {
  AttemptRow,
  ClerkIdentity,
  ClerkUserSnapshot,
  IdentityStore,
  Logger,
  ManagedRow,
} from "./ports.js"

/**
 * The sign-in bridge (sso.md 2.1): from "this IdP says this is Ada" to a Clerk
 * session the gate will accept.
 *
 *   1. `startLogin`: an attempt row (state, nonce, PKCE verifier, the hash of
 *      a cookie only this browser holds), then the engine's redirect.
 *   2. The engine verifies the IdP's answer (#338 OIDC, #339 SAML, the test
 *      engine here) and calls `completeLogin` with what it verified.
 *   3. `completeLogin`: the attempt is unused, unexpired and this browser's;
 *      the person is resolved (link, pre-provisioned, claimed, JIT, or
 *      refused); their membership is kept or made; the account is managed;
 *      the browser gets a one-time handoff CODE.
 *   4. `redeemHandoff`: the same browser swaps the code for a Clerk sign-in
 *      token (minted now, 60 seconds, `second_factor_verification: fresh`)
 *      and a handoff SECRET.
 *   5. apps/auth signs in with the ticket, then `bind`: Clerk confirms THIS
 *      new session came from THAT ticket, and `sso_sessions` gets its row.
 *
 * ⚠ THE BROWSER NEVER HOLDS ANYTHING WORTH STEALING FOR LONG. The code lives
 * two minutes and works once, from the browser that started; the ticket lives
 * sixty seconds; the handoff secret only binds a session that already exists.
 * Every one is stored as a hash and spent with a compare-and-set.
 */

export interface Engine {
  protocol: Protocol
  /** Where the browser goes to authenticate. */
  begin(
    connection: Connection,
    attempt: {
      state: string
      nonce: string
      pkceVerifier: string | null
      /**
       * ⚠ `step_up` MUST MAKE THE IdP ASK AGAIN: OIDC `prompt=login max_age=0`,
       * SAML `ForceAuthn="true"` (sso.md 2.4). Without it an IdP answers from
       * its own session and the step-up fails `step_up_stale`.
       */
      purpose: AttemptPurpose
    },
  ): Promise<{ redirectUrl: string; requestId?: string | null }>
  /** Whether this engine needs a PKCE verifier kept for its callback. */
  pkce: boolean
}

export interface BridgeDeps {
  store: IdentityStore
  clerk: ClerkIdentity
  engines: ReadonlyMap<Protocol, Engine>
  /**
   * Membership through our roles code (#335): `added` (or already a member,
   * whose role this never changes) or `full` (capacity, #327). `role` is what
   * a NEW member joins with: the connection's group rules' answer (#341).
   */
  join(input: {
    tenantId: string
    orgId: string
    userId: string
    role: JoinRole
  }): Promise<"added" | "full">
  /**
   * Whether this person is an owner or an admin of the workspace in our roles
   * table (#335): the people SSO never takes over (decision 7).
   */
  isExempt(tenantId: string, userId: string): Promise<boolean>
  /**
   * SCIM's pre-provisioned person for this subject (#342): their Clerk user
   * id, null for nobody, or `deprovisioned` when a directory knows the person
   * and says they are switched off (the sign-in is refused, not resolved some
   * other way).
   */
  preProvisioned?: (ctx: ResolveContext) => Promise<string | null | "deprovisioned">
  /**
   * Whether the workspace's directories have switched this account off (#342).
   * Asked for every account a sign-in resolves to, however it was found:
   * deprovisioning ends the managed row and the membership, not the identity
   * link, so without this the person's next sign-in would put them back.
   */
  deprovisioned?: (tenantId: string, clerkUserId: string) => Promise<boolean>
  /**
   * Just-in-time creation (#341). Unset, an unknown person is refused
   * whatever the connection says; set, a connection with `jit_enabled`
   * creates them (identity/jit.ts).
   */
  jit?: boolean
  /**
   * The group rules' role written to our roles table at every sign-in (#341,
   * console/roles.ts `syncRole`). Absent: roles are left as they are.
   */
  syncRole?: (input: {
    tenantId: string
    userId: string
    role: JoinRole
  }) => Promise<SyncOutcome>
  /**
   * The waiting list (#327): a request filed as auto-join files one when the
   * workspace is full (`JoinStore.fileRequest` with `full`). Absent: a full
   * workspace is a plain refusal.
   */
  waitlist?: (
    tenantId: string,
    input: { userId: string; email: string; via: string },
  ) => Promise<"created" | "exists">
  log: Logger
  now?: () => Date
}

export interface ResolveContext {
  tenantId: string
  connection: Connection
  assertion: Assertion
  email: string
}

const clock = (d: { now?: () => Date }) => (d.now ?? (() => new Date()))()

// ── 1. Start ─────────────────────────────────────────────────────────────

export type StartOutcome =
  /**
   * `protocol` tells apps/auth which cookies the callback will need: a SAML
   * response is a cross-site POST, so it sets one more (#339).
   */
  | { outcome: "redirect"; redirectUrl: string; protocol: Protocol }
  | { outcome: "refused"; reason: Refusal }

/**
 * ⚠ THE BINDING VALUE IS THE BROWSER'S, NOT OURS. apps/auth draws it, puts it
 * in an httpOnly cookie on its own origin and sends it here once; we keep only
 * its hash. Whoever finishes this sign-in must present it again, which a link
 * forwarded to somebody else, or a callback replayed from another machine,
 * cannot.
 */
export async function startLogin(
  d: Pick<BridgeDeps, "store" | "engines" | "log" | "now">,
  input: {
    connectionId: string
    purpose: AttemptPurpose
    binding: string
    returnTo: string | null
    /** For `step_up`: the verified session being made fresh. */
    stepUp?: { userId: string; sessionId: string }
  },
): Promise<StartOutcome> {
  const connection = await d.store.connectionForStart(input.connectionId)
  if (!connection) return { outcome: "refused", reason: "connection_inactive" }
  const usable =
    input.purpose === "test_run"
      ? connection.status === "testing" || connection.status === "active"
      : connection.status === "active"
  if (!usable) return { outcome: "refused", reason: "connection_inactive" }
  const engine = d.engines.get(connection.protocol)
  if (!engine) return { outcome: "refused", reason: "engine_disabled" }

  if (input.purpose === "step_up") {
    const session = input.stepUp
      ? await d.store.sessionRow(connection.tenantId, input.stepUp.sessionId)
      : null
    if (
      !session ||
      session.revokedAt ||
      session.clerkUserId !== input.stepUp?.userId ||
      session.connectionId !== connection.id
    )
      return { outcome: "refused", reason: "step_up_mismatch" }
  }

  const state = newSecret()
  const nonce = newSecret()
  const pkceVerifier = engine.pkce ? newSecret() : null
  const begun = await engine.begin(connection, {
    state,
    nonce,
    pkceVerifier,
    purpose: input.purpose,
  })
  await d.store.createAttempt({
    tenantId: connection.tenantId,
    connectionId: connection.id,
    purpose: input.purpose,
    stateHash: hashSecret(state),
    bindingHash: hashSecret(input.binding),
    nonce,
    pkceVerifier,
    requestId: begun.requestId ?? null,
    returnTo: input.returnTo,
    stepUpSessionId: input.stepUp?.sessionId ?? null,
    expiresAt: new Date(clock(d).getTime() + ATTEMPT_TTL_MS),
  })
  return {
    outcome: "redirect",
    redirectUrl: begun.redirectUrl,
    protocol: connection.protocol,
  }
}

/** What an engine's callback needs back from the attempt it is finishing. */
export async function attemptForCallback(
  d: Pick<BridgeDeps, "store">,
  state: string,
): Promise<AttemptRow | null> {
  return d.store.attemptByState(hashSecret(state))
}

// ── 3. Complete ──────────────────────────────────────────────────────────

export type CompleteOutcome =
  | { outcome: "signed_in"; code: string; returnTo: string | null }
  | { outcome: "tested"; testRunId: string; passed: boolean; returnTo: string | null }
  | { outcome: "stepped_up"; returnTo: string | null }
  /** `message`, when set, is what the person is told instead of `refusalMessage`. */
  | { outcome: "refused"; reason: Refusal; message?: string }

type Resolved =
  | {
      ok: true
      userId: string
      user: ClerkUserSnapshot
      path: "linked" | "scim" | "claimed" | "jit"
      identityId: string | null
      orgId: string
      email: string
      /** Its managed row, if any: always this workspace's by now. */
      managed: ManagedRow | null
      /** JIT made this Clerk user during this sign-in (#341). */
      created: boolean
    }
  /** A test run that JIT would have created somebody for (#341): nobody is. */
  | { ok: "would_create"; orgId: string; email: string }
  | { ok: false; reason: Refusal; extra?: Record<string, unknown> }

type Refuse = (
  reason: Refusal,
  extra?: Record<string, unknown>,
  message?: string,
) => Promise<{ outcome: "refused"; reason: Refusal; message?: string }>

type Opened =
  | { ok: true; attempt: AttemptRow; refuse: Refuse }
  | { ok: false; outcome: CompleteOutcome }

/**
 * Whether a callback may even be looked at: this browser's, unused, unexpired.
 * An engine asks this BEFORE it talks to the IdP (#338), so a callback replayed
 * from another machine never spends the real person's authorization code; the
 * bridge asks again, and spends the attempt, in `openAttempt`.
 */
export function precheckAttempt(
  attempt: AttemptRow,
  binding: string,
  now: Date,
): Refusal | null {
  if (!sameHash(attempt.bindingHash, hashSecret(binding))) return "wrong_browser"
  if (attempt.consumedAt) return "attempt_used"
  if (attempt.expiresAt.getTime() <= now.getTime()) return "attempt_expired"
  return null
}

/**
 * The attempt a callback names, checked and SPENT, with the refusal that
 * records why on it and in the audit log.
 *
 * ⚠ THE ATTEMPT IS SPENT BEFORE ANYTHING ELSE HAPPENS. Two callbacks for one
 * attempt (a replay, a double click) race on `consumed_at`; the loser is
 * refused before it reads a user, so nothing the winner does can be done
 * twice.
 */
async function openAttempt(
  d: Pick<BridgeDeps, "store" | "log">,
  input: { state: string; binding: string; subject?: string },
  now: Date,
): Promise<Opened> {
  const attempt = await d.store.attemptByState(hashSecret(input.state))
  if (!attempt) {
    d.log.warn({}, "an SSO callback named no attempt we know")
    return { ok: false, outcome: { outcome: "refused", reason: "attempt_unknown" } }
  }
  const refuse: Refuse = async (reason, extra = {}, message) => {
    await d.store.finishAttempt(attempt.tenantId, attempt.id, {
      outcome: "refused",
      failureReason: reason,
    })
    await d.store.record(attempt.tenantId, {
      type: attempt.purpose === "step_up" ? "step_up.failed" : "sign_in.failed",
      connectionId: attempt.connectionId,
      reason,
      data: {
        attemptId: attempt.id,
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...extra,
      },
    })
    return message !== undefined
      ? { outcome: "refused" as const, reason, message }
      : { outcome: "refused" as const, reason }
  }

  // ⚠ WRONG BROWSER AND EXPIRED ARE CHECKED BEFORE THE ATTEMPT IS SPENT, so a
  // stranger replaying a callback cannot burn the real person's attempt.
  if (!sameHash(attempt.bindingHash, hashSecret(input.binding))) {
    await d.store.record(attempt.tenantId, {
      type: "sign_in.failed",
      connectionId: attempt.connectionId,
      reason: "wrong_browser",
      data: { attemptId: attempt.id },
    })
    return { ok: false, outcome: { outcome: "refused", reason: "wrong_browser" } }
  }
  // ⚠ A REPLAY IS RECORDED BUT DOES NOT TOUCH THE ATTEMPT: `refuse` would
  // overwrite the outcome the first, real completion wrote.
  const replayed = async (): Promise<Opened> => {
    await d.store.record(attempt.tenantId, {
      type: attempt.purpose === "step_up" ? "step_up.failed" : "sign_in.failed",
      connectionId: attempt.connectionId,
      reason: "attempt_used",
      data: { attemptId: attempt.id },
    })
    return { ok: false, outcome: { outcome: "refused", reason: "attempt_used" } }
  }
  if (attempt.consumedAt) return replayed()
  if (attempt.expiresAt.getTime() <= now.getTime())
    return { ok: false, outcome: await refuse("attempt_expired") }
  if (!(await d.store.consumeAttempt(attempt.tenantId, attempt.id, now)))
    return replayed()
  return { ok: true, attempt, refuse }
}

/**
 * An engine could not, or would not, accept what the IdP sent back (#338): an
 * `error=` redirect, a response that failed verification, a Google account
 * outside the workspace. The attempt is spent and the refusal audited exactly
 * as `completeLogin` would have.
 *
 * ⚠ `extra` IS AUDITED, SO NOTHING SECRET GOES IN IT: never the code, the
 * state, a token or a verifier. A short failure code and a claim NAME at most.
 */
export async function refuseLogin(
  d: Pick<BridgeDeps, "store" | "log" | "now">,
  input: {
    state: string
    binding: string
    reason: Refusal
    extra?: Record<string, unknown>
  },
): Promise<CompleteOutcome> {
  const opened = await openAttempt(d, input, clock(d))
  if (!opened.ok) return opened.outcome
  return opened.refuse(input.reason, input.extra)
}

/** Called by an engine AFTER it verified the IdP's response. */
export async function completeLogin(
  d: BridgeDeps,
  input: {
    state: string
    binding: string
    assertion: Assertion
    /** The engine that verified `assertion`: it must be the connection's own. */
    protocol: Protocol
  },
): Promise<CompleteOutcome> {
  const now = clock(d)
  const opened = await openAttempt(
    d,
    { state: input.state, binding: input.binding, subject: input.assertion.subject },
    now,
  )
  if (!opened.ok) return opened.outcome
  const { attempt, refuse } = opened

  const connection = await d.store.connection(attempt.tenantId, attempt.connectionId)
  const usable =
    connection &&
    d.engines.has(connection.protocol) &&
    (attempt.purpose === "test_run"
      ? connection.status === "testing" || connection.status === "active"
      : connection.status === "active")
  if (!connection || !usable) return refuse("connection_inactive")
  /*
   * ⚠ ONLY THE CONNECTION'S OWN ENGINE MAY FINISH ITS ATTEMPT. Otherwise, in a
   * process where two engines run, an OIDC attempt could be finished by an
   * assertion some other engine "verified" - the test engine verifies nothing.
   */
  if (connection.protocol !== input.protocol) return refuse("engine_mismatch")
  const assertion = input.assertion

  if (connection.mfaRequired && !assertionProvesMfa(assertion))
    return refuse("mfa_required", {
      amr: assertion.amr ?? [],
      acr: assertion.acr ?? null,
    })

  if (attempt.purpose === "step_up")
    return stepUp(d, attempt, connection, assertion, refuse)

  const mode = attempt.purpose === "test_run" ? "test_run" : "sign_in"
  const resolved = await resolve(d, attempt.tenantId, connection, assertion, mode)
  /*
   * ⚠ THE ROLE IS THE IdP's GROUPS, READ AT EVERY SIGN-IN (#341). The rules
   * are this connection's; no rule matching gives the default, member. A
   * connection with no rules leaves roles to the Team page.
   */
  const rules = await d.store.groupRules(attempt.tenantId, connection.id)
  const mapped = roleFromGroups(rules, assertion.groups)

  if (attempt.purpose === "test_run") {
    const passed = resolved.ok !== false
    const reason = resolved.ok === false ? resolved.reason : null
    const role = { role: mapped.role, rule: mapped.rule?.id ?? null }
    const run = await d.store.recordTestRun(attempt.tenantId, {
      connectionId: connection.id,
      attemptId: attempt.id,
      outcome: passed ? "passed" : "failed",
      reason,
      claims: claimsOf(assertion),
      resolution:
        resolved.ok === true
          ? {
              path: resolved.path,
              clerkUserId: resolved.userId,
              email: resolved.email,
              ...role,
            }
          : resolved.ok === "would_create"
            ? {
                path: "jit",
                wouldCreate: true,
                email: resolved.email,
                // What Clerk will require of the new person: the console says
                // so before going live, instead of a refused first sign-in.
                names: {
                  given: readName(assertion.givenName) !== null,
                  family: readName(assertion.familyName) !== null,
                },
                ...role,
              }
            : { refused: resolved.reason },
    })
    await d.store.finishAttempt(attempt.tenantId, attempt.id, {
      outcome: "tested",
      failureReason: reason,
    })
    await d.store.record(attempt.tenantId, {
      type: "test_run.completed",
      connectionId: connection.id,
      reason,
      data: { testRunId: run.id, passed },
    })
    return {
      outcome: "tested",
      testRunId: run.id,
      passed,
      returnTo: attempt.returnTo,
    }
  }

  if (resolved.ok === false) return refuse(resolved.reason, resolved.extra)
  // A sign-in never resolves to "would create"; refused rather than trusted.
  if (resolved.ok !== true) return refuse("no_account")

  /*
   * ⚠ AN OWNER OR ADMIN WHO IS NOT MANAGED IS NEVER SIGNED IN THROUGH SSO
   * (decision 7), refused HERE, before anything is joined, linked or minted.
   * They keep their own way in (a passkey), so a broken or hostile IdP can
   * never lock the workspace out of itself - and anybody who can set up a
   * connection and run the IdP behind it (an admin, the planned IT-admin
   * role) can never sign in AS an owner or a fellow admin by asserting their
   * address. Letting them use SSO deliberately, from their own session, is
   * #340's.
   */
  const existing = resolved.managed
  /*
   * ⚠ AND A PRIVILEGED ACCOUNT THAT IS MANAGED SIGNS IN ONLY THROUGH THE LINK
   * IT ALREADY HAS (#338). A member claimed through SSO and later made an
   * owner or admin is managed, so the rule above lets them through; but only
   * as `linked` on this very connection. Never claimed by address, made by
   * JIT or found by SCIM on another one: otherwise an admin could stand up a
   * second connection on an IdP they run, move the domain to it, and sign in
   * as that owner. Changing the trust of the connection they ARE linked on
   * needs an owner (routes/console/identity-oidc.ts).
   */
  const exempt = await d.isExempt(attempt.tenantId, resolved.userId)
  if (exempt && (!existing || resolved.path !== "linked"))
    return refuse("role_exempt", { clerkUserId: resolved.userId })

  const takeOver = () =>
    manage(d, {
      tenantId: attempt.tenantId,
      connectionId: connection.id,
      resolved,
    })

  /*
   * ⚠ SOMEBODY JIT JUST MADE IS MANAGED BEFORE ANYTHING ELSE CAN FAIL. The
   * account exists at Clerk from this moment, with a verified company address
   * and no password; managed, the gateway sends every other way in back to
   * the IdP. A failure after this leaves a managed person who is not a member
   * yet - their next sign-in finishes the job - never a free-standing one.
   */
  let managedNow = false
  if (resolved.created) {
    if ((await takeOver()) === "elsewhere") return refuse("managed_elsewhere")
    managedNow = true
    await d.store.record(attempt.tenantId, {
      type: "jit.provisioned",
      subjectUserId: resolved.userId,
      connectionId: connection.id,
      data: { email: resolved.email, ...ruleData(mapped) },
    })
  }

  // ── Membership, link, managed ──
  const joined = await d.join({
    tenantId: attempt.tenantId,
    orgId: resolved.orgId,
    userId: resolved.userId,
    role: mapped.role,
  })
  if (joined === "full") {
    /*
     * ⚠ A FULL WORKSPACE TURNS JIT INTO A WAITING-LIST REQUEST (#327), as it
     * does auto-join: the person exists and is managed, their request is
     * under the admins' Requests, and they are told so - not an error. Only
     * for people JIT made (now, or on an earlier sign-in that also found it
     * full); anybody else is refused as before.
     */
    const jitPerson = resolved.path === "jit" || existing?.reason === "jit"
    if (d.waitlist && jitPerson) {
      const filed = await d.waitlist(attempt.tenantId, {
        userId: resolved.userId,
        email: resolved.email,
        via: emailDomain(resolved.email),
      })
      await d.store.record(attempt.tenantId, {
        type: "jit.waitlisted",
        subjectUserId: resolved.userId,
        connectionId: connection.id,
        reason: "workspace_full",
        data: { request: filed },
      })
      const name = (await d.store.workspaceName(attempt.tenantId)) ?? "This workspace"
      return refuse(
        "waiting_list",
        { clerkUserId: resolved.userId },
        `${name} is full right now. We've asked its admins to add you.`,
      )
    }
    return refuse("workspace_full", { clerkUserId: resolved.userId })
  }

  const identityId =
    resolved.identityId ??
    (
      await d.store.link(attempt.tenantId, {
        connectionId: connection.id,
        subject: assertion.subject,
        clerkUserId: resolved.userId,
        email: resolved.email,
      })
    ).id

  if (!managedNow && (await takeOver()) === "elsewhere")
    return refuse("managed_elsewhere")

  await syncRole(d, {
    tenantId: attempt.tenantId,
    connectionId: connection.id,
    userId: resolved.userId,
    mapped,
    hasRules: rules.length > 0,
  })
  // A person JIT just made has the IdP's names already.
  if (!resolved.created)
    await syncProfile(d, {
      tenantId: attempt.tenantId,
      connectionId: connection.id,
      user: resolved.user,
      assertion,
    })
  await d.store.touchIdentity(attempt.tenantId, identityId, resolved.email, now)

  const code = newSecret()
  await d.store.finishAttempt(attempt.tenantId, attempt.id, {
    outcome: "signed_in",
    clerkUserId: resolved.userId,
    identityId,
    clerkOrgId: resolved.orgId,
    idpSession: assertion.idpSession ?? null,
    authTime: assertion.authTime,
    handoffCodeHash: hashSecret(code),
    handoffExpiresAt: new Date(now.getTime() + HANDOFF_TTL_MS),
  })
  await d.store.record(attempt.tenantId, {
    type: "sign_in.verified",
    subjectUserId: resolved.userId,
    connectionId: connection.id,
    data: { attemptId: attempt.id, path: resolved.path },
  })
  return { outcome: "signed_in", code, returnTo: attempt.returnTo }
}

/** The rule behind a role, for the audit log: its id and group, or the default. */
function ruleData(mapped: MappedRole): Record<string, unknown> {
  return {
    role: mapped.role,
    rule: mapped.rule
      ? {
          id: mapped.rule.id,
          group: mapped.rule.groupValue,
          precedence: mapped.rule.precedence,
        }
      : null,
  }
}

/**
 * Makes (or keeps) the account managed by this workspace, and takes every
 * other way in away from it.
 */
async function manage(
  d: BridgeDeps,
  input: {
    tenantId: string
    connectionId: string
    resolved: Extract<Resolved, { ok: true }>
  },
): Promise<"created" | "kept" | "elsewhere"> {
  const { resolved, tenantId, connectionId } = input
  const existing = resolved.managed
  const reason: ManagedReason =
    resolved.path === "claimed"
      ? "claimed"
      : resolved.path === "jit"
        ? "jit"
        : resolved.path === "scim"
          ? "scim"
          : "linked"
  /*
   * ⚠ WHAT A MANAGED ACCOUNT KEEPS. Newly claimed: the asserted address and
   * every address it already held verified. Already managed: the addresses on
   * its row plus the one the IdP asserts now (a rename), so a sign-in never
   * blesses an address that slipped onto the account some other way.
   */
  const keep = verifiedAddresses(
    resolved.user,
    existing ? [resolved.email, ...existing.emails] : null,
    resolved.email,
  )

  const claimed = await d.store.claimManaged(tenantId, {
    clerkUserId: resolved.userId,
    tenantId,
    connectionId,
    reason,
    emails: keep,
  })
  if (claimed === "elsewhere") return claimed

  /*
   * ⚠ A NEWLY MANAGED ACCOUNT LOSES EVERY OTHER WAY IN, AND EVERY SESSION IT
   * HAD, BEFORE A TICKET IS EVER MINTED. Somebody who signed up with a
   * password before their company turned on SSO keeps their account and
   * their other workspaces (sso.md 2.3, "claiming"), but not the password, and
   * not the sessions that password made: those never passed the IdP.
   */
  if (claimed === "created") {
    for (const session of await d.clerk.activeSessions(resolved.userId))
      await d.clerk.revokeSession(session.id)
    await d.store.record(tenantId, {
      type: "managed.claimed",
      subjectUserId: resolved.userId,
      connectionId,
      reason,
      // #340 emails the person that their account is now managed. Until
      // the console's identity screens ship there is no page to link them to;
      // this event is the notice of record.
      data: { email: resolved.email, notified: false },
    })
  }
  if (claimed === "kept") {
    /*
     * ⚠ THE STORED LIST FOLLOWS THE IdP. An address the IdP now asserts (a
     * rename) must be on the row, or the watchdog's next pass - which reads
     * the row, not this sign-in - would strip the very address the person
     * just signed in with, and the gateway would not know it as managed.
     * The connection follows too: it is where the gate sends them back to.
     */
    await d.store.setManagedEmails(tenantId, resolved.userId, keep, connectionId)
  }
  await enforceManaged(
    d,
    { tenantId, clerkUserId: resolved.userId, emails: keep },
    claimed === "created" ? "claimed" : "sign_in",
  )
  return claimed
}

/**
 * The group rules' role, written to our roles table (#341).
 *
 * ⚠ ONLY THROUGH THE ROLES CODE (`syncRole`), SO ITS RULES HOLD: a joining
 * role only, never owner, and an owner's row never touched - which is also
 * why the last owner can never be demoted from here. Owners and admins who
 * are not managed never get this far (`role_exempt` above).
 *
 * ⚠ EVERY CHANGE IS AUDITED WITH THE RULE THAT MADE IT, or `rule: null` for
 * the default.
 */
async function syncRole(
  d: BridgeDeps,
  input: {
    tenantId: string
    connectionId: string
    userId: string
    mapped: MappedRole
    hasRules: boolean
  },
): Promise<void> {
  if (!input.hasRules || !d.syncRole) return
  const synced = await d.syncRole({
    tenantId: input.tenantId,
    userId: input.userId,
    role: input.mapped.role,
  })
  if (synced.outcome === "changed")
    await d.store.record(input.tenantId, {
      type: "role.synced",
      subjectUserId: input.userId,
      connectionId: input.connectionId,
      data: { from: synced.from, to: synced.to, rule: ruleData(input.mapped).rule },
    })
  if (synced.outcome === "owner_kept")
    await d.store.record(input.tenantId, {
      type: "role.sync_skipped",
      subjectUserId: input.userId,
      connectionId: input.connectionId,
      reason: "owner",
      data: { wanted: input.mapped.role, rule: ruleData(input.mapped).rule },
    })
}

/**
 * Profile sync (#341, Clerk's `sync_user_attributes`): the IdP's names to
 * Clerk when they changed.
 *
 * ⚠ AUDITED AS "PROFILE UPDATED" AND NOTHING MORE: the names are the person's
 * data, not the log's.
 *
 * ⚠ A FAILURE IS LOGGED, NOT A REFUSAL. A name decides nobody's access; the
 * sign-in goes on and the next one tries again.
 */
async function syncProfile(
  d: BridgeDeps,
  input: {
    tenantId: string
    connectionId: string
    user: ClerkUserSnapshot
    assertion: Assertion
  },
): Promise<void> {
  const changes = profileChanges(input.user, input.assertion)
  if (!changes) return
  try {
    await d.clerk.updateProfile(input.user.id, changes)
  } catch (error) {
    d.log.warn(
      { err: String(error), clerkUserId: input.user.id },
      "could not sync an SSO profile to Clerk",
    )
    return
  }
  await d.store.record(input.tenantId, {
    type: "profile.updated",
    subjectUserId: input.user.id,
    connectionId: input.connectionId,
  })
}

/**
 * Who this is, by the only rules that may answer it.
 *
 *   1. An existing link `(connection, subject)`.
 *   2. A person SCIM already provisioned for this subject (#342).
 *   3. An existing Clerk account holding this address VERIFIED, on one of the
 *      connection's live domains, claimed (sso.md 2.3).
 *   4. JIT (#341), when the connection allows it and NO Clerk account holds
 *      the address at all.
 *   5. Nobody: refused.
 *
 * ⚠ NEVER AN EMAIL-ONLY MATCH OUTSIDE THE WORKSPACE'S VERIFIED DOMAINS. Rule 3
 * needs all of: the IdP vouching for the address, the address on a domain
 * this workspace has proved and still holds (not lapsed, not displaced), and
 * Clerk holding it verified. Any one missing and the person is refused, not
 * guessed at. JIT needs the same first two.
 */
async function resolve(
  d: BridgeDeps,
  tenantId: string,
  connection: Connection,
  assertion: Assertion,
  mode: "sign_in" | "test_run",
): Promise<Resolved> {
  const orgId = await d.store.workspaceOrg(tenantId)
  if (!orgId) return { ok: false, reason: "workspace_gone" }
  const email = normaliseEmail(assertion.email)
  if (!email) return { ok: false, reason: "no_email" }
  const live = await d.store.liveDomains(tenantId, connection.id)
  // ⚠ EVEN FOR A LINKED PERSON: displacement disables SSO for the domain.
  if (!onLiveDomain(email, live)) return { ok: false, reason: "domain_not_verified" }

  /*
   * ⚠ AT MOST TWICE. JIT answering `exists` means a Clerk account for the
   * address appeared while we looked (a sign-in racing ours, the person
   * signing up by hand); the second pass finds it by link or as a holder,
   * and never creates.
   */
  for (let pass = 0; pass < 2; pass++) {
    const linked = await d.store.identityBySubject(
      tenantId,
      connection.id,
      assertion.subject,
    )
    let userId: string | null = linked?.clerkUserId ?? null
    let identityId: string | null = linked?.id ?? null
    let path: "linked" | "scim" | "claimed" | "jit" = "linked"
    let created = false

    if (!userId) {
      if (!assertion.emailVerified) return { ok: false, reason: "email_unverified" }
      const ctx: ResolveContext = { tenantId, connection, assertion, email }
      const pre = (await d.preProvisioned?.(ctx)) ?? null
      if (pre === "deprovisioned") return { ok: false, reason: "deprovisioned" }
      if (pre) {
        userId = pre
        path = "scim"
      } else {
        const all = await d.clerk.usersByEmail(email)
        const holders = all.filter((u) =>
          u.emails.some((e) => e.verified && e.address.toLowerCase() === email),
        )
        if (holders.length > 1) return { ok: false, reason: "ambiguous_account" }
        // A test run asks what JIT would do once the connection is live;
        // it never creates anybody (`would_create` below).
        const jit =
          d.jit === true &&
          jitAllowed(
            mode === "test_run" ? { ...connection, status: "active" } : connection,
          )
        if (holders.length === 1) {
          userId = holders[0]!.id
          path = "claimed"
        } else if (jit && all.length > 0) {
          /*
           * ⚠ NEVER JIT FOR AN ADDRESS A CLERK ACCOUNT ALREADY HOLDS, EVEN
           * UNVERIFIED. Clerk would refuse the creation anyway; and claiming
           * is the only path to an existing account, which needs the address
           * verified on it.
           */
          return { ok: false, reason: "no_account", extra: { jit: "address_held" } }
        } else if (jit) {
          // ⚠ BEFORE ANYTHING IS CREATED: the block list wins (sso.md 2.7).
          if (await d.store.isBlocked(tenantId, email))
            return { ok: false, reason: "blocked" }
          if (mode === "test_run") return { ok: "would_create", orgId, email }
          const made = await provision(d, { tenantId, connection, assertion, email })
          if (made.outcome === "exists") continue
          if (made.outcome === "incomplete")
            return { ok: false, reason: "profile_incomplete" }
          userId = made.userId
          identityId = made.identityId
          path = made.outcome === "created" ? "jit" : "linked"
          created = made.outcome === "created"
        }
      }
      if (!userId) return { ok: false, reason: "no_account" }
      // Somebody else's subject already holds this account on this connection.
      if (
        identityId === null &&
        (await d.store.identityByUser(tenantId, connection.id, userId))
      )
        return { ok: false, reason: "already_linked" }
    }

    const user = await d.clerk.user(userId)
    if (!user) return { ok: false, reason: "no_account" }
    if (user.banned) return { ok: false, reason: "account_banned" }
    if (await d.deprovisioned?.(tenantId, userId))
      return { ok: false, reason: "deprovisioned" }
    if (await d.store.isBlocked(tenantId, email))
      return { ok: false, reason: "blocked" }
    const managed = await d.store.managedByUser(userId)
    if (managed && managed.tenantId !== tenantId)
      return { ok: false, reason: "managed_elsewhere" }

    return {
      ok: true,
      userId,
      user,
      path,
      identityId,
      orgId,
      email,
      managed,
      created,
    }
  }
  return { ok: false, reason: "no_account", extra: { jit: "raced" } }
}

/**
 * The addresses a managed account keeps, the asserted one first: of the
 * candidates (every address when none are given), only those Clerk holds
 * VERIFIED on this account. An address the account does not hold is never
 * listed, or the gateway would refuse whoever else signs in with it.
 */
export function verifiedAddresses(
  user: ClerkUserSnapshot,
  candidates: readonly string[] | null,
  email: string,
): string[] {
  const verified = user.emails
    .filter((e) => e.verified)
    .map((e) => e.address.toLowerCase())
  const held = new Set(verified)
  const wanted = candidates ? candidates.map((a) => a.toLowerCase()) : verified
  return [...new Set([email, ...wanted])].filter((a) => held.has(a))
}

/** The assertion as a test run shows it: claims, no secrets (no token, no code). */
function claimsOf(assertion: Assertion): Record<string, unknown> {
  return {
    subject: assertion.subject,
    email: assertion.email,
    emailVerified: assertion.emailVerified,
    givenName: assertion.givenName ?? null,
    familyName: assertion.familyName ?? null,
    groups: assertion.groups ?? [],
    amr: assertion.amr ?? [],
    acr: assertion.acr ?? null,
    authTime: assertion.authTime?.toISOString() ?? null,
    attributes: assertion.attributes ?? {},
  }
}

/**
 * A step-up (sso.md 2.4): the IdP asked again, so the session is fresh.
 *
 * ⚠ THE SAME PERSON, AND A REAL RE-AUTHENTICATION. The subject must resolve,
 * through its existing link only, to the user of the session being made
 * fresh; and the IdP's `auth_time` must be within `STEP_UP_MAX_AGE_MS`,
 * because an IdP that answered from its own long-lived session (no
 * `prompt=login` honoured) proved nothing new.
 */
async function stepUp(
  d: BridgeDeps,
  attempt: AttemptRow,
  connection: Connection,
  assertion: Assertion,
  refuse: Refuse,
): Promise<CompleteOutcome> {
  const now = clock(d)
  const linked = await d.store.identityBySubject(
    attempt.tenantId,
    connection.id,
    assertion.subject,
  )
  const session = attempt.stepUpSessionId
    ? await d.store.sessionRow(attempt.tenantId, attempt.stepUpSessionId)
    : null
  if (
    !linked ||
    !session ||
    session.revokedAt ||
    session.clerkUserId !== linked.clerkUserId
  )
    return refuse("step_up_mismatch")
  const at = assertion.authTime
  if (
    !at ||
    now.getTime() - at.getTime() > STEP_UP_MAX_AGE_MS ||
    at.getTime() > now.getTime() + CLOCK_SKEW_MS
  )
    return refuse("step_up_stale")
  await d.store.setFresh(attempt.tenantId, session.sessionId, at)
  await d.store.finishAttempt(attempt.tenantId, attempt.id, {
    outcome: "stepped_up",
    clerkUserId: linked.clerkUserId,
    identityId: linked.id,
    authTime: at,
  })
  await d.store.record(attempt.tenantId, {
    type: "step_up.succeeded",
    subjectUserId: linked.clerkUserId,
    connectionId: connection.id,
    sessionId: session.sessionId,
  })
  return { outcome: "stepped_up", returnTo: attempt.returnTo }
}

// ── 4. Redeem ────────────────────────────────────────────────────────────

export type RedeemOutcome =
  | { outcome: "ticket"; ticket: string; handoff: string }
  | { outcome: "refused"; reason: Refusal }

/**
 * The browser swaps its handoff code for a Clerk ticket.
 *
 * ⚠ THE TICKET IS MINTED HERE, NOT AT `completeLogin`, AND NEVER STORED. Its
 * sixty seconds start when the browser is ready to use it, and nothing at
 * rest can be replayed into a session. Only its id is kept, for `bind`.
 *
 * ⚠ A MINT THAT FAILS AFTER THE CODE IS SPENT COSTS A RESTART, NOT A SECOND
 * TICKET. The code is claimed first; Clerk failing then throws (503), and the
 * person starts the sign-in again. Never two tickets for one login.
 */
export async function redeemHandoff(
  d: Pick<BridgeDeps, "store" | "clerk" | "log" | "now">,
  input: { code: string; binding: string },
): Promise<RedeemOutcome> {
  const now = clock(d)
  const attempt = await d.store.attemptByHandoffCode(hashSecret(input.code))
  if (
    !attempt ||
    attempt.outcome !== "signed_in" ||
    !attempt.clerkUserId ||
    !attempt.clerkOrgId
  )
    return { outcome: "refused", reason: "attempt_unknown" }
  const refuse = async (reason: Refusal): Promise<RedeemOutcome> => {
    await d.store.record(attempt.tenantId, {
      type: "handoff.failed",
      subjectUserId: attempt.clerkUserId,
      connectionId: attempt.connectionId,
      reason,
      data: { attemptId: attempt.id },
    })
    return { outcome: "refused", reason }
  }
  if (!sameHash(attempt.bindingHash, hashSecret(input.binding)))
    return refuse("wrong_browser")
  if (attempt.redeemedAt) return refuse("attempt_used")
  if (!attempt.handoffExpiresAt || attempt.handoffExpiresAt.getTime() <= now.getTime())
    return refuse("attempt_expired")
  if (!(await d.store.claimRedeem(attempt.tenantId, attempt.id, now)))
    return refuse("attempt_used")

  const token = await d.clerk.mintSignInToken({
    userId: attempt.clerkUserId,
    orgId: attempt.clerkOrgId,
  })
  const handoff = newSecret()
  await d.store.recordToken(attempt.tenantId, attempt.id, {
    signInTokenId: token.id,
    mintedAt: now,
    handoffSecretHash: hashSecret(handoff),
  })
  return { outcome: "ticket", ticket: token.token, handoff }
}

// ── 5. Bind ──────────────────────────────────────────────────────────────

export type BindOutcome =
  | { outcome: "bound"; returnTo: string | null }
  | {
      outcome: "refused"
      reason:
        | "unknown"
        | "used"
        | "expired"
        | "wrong_user"
        | "session_mismatch"
        | "not_ticket"
        | "token_not_accepted"
    }

/**
 * `POST /sso/bind`: the new Clerk session, proved to be the one our ticket
 * made, becomes a bound SSO session.
 *
 * ⚠ CLERK HAS NO "WAS THIS TOKEN REDEEMED" READ (a GET is 404, sso.md 1.1),
 * SO IT IS ASKED THREE WAYS AT ONCE. The session is this user's, active, and
 * no older than the mint; its client last signed in with `ticket` (P4); and
 * revoking the token now is refused with `sign_in_token_cannot_be_revoked_code`,
 * which Clerk answers for an accepted token. A token still pending revokes
 * cleanly instead - so it was NOT what made this session, the bind is refused,
 * and the token is dead either way.
 */
export async function bind(
  d: Pick<BridgeDeps, "store" | "clerk" | "log" | "now">,
  input: { userId: string; sessionId: string; handoff: string },
): Promise<BindOutcome> {
  const now = clock(d)
  const attempt = await d.store.attemptByHandoffSecret(hashSecret(input.handoff))
  if (
    !attempt ||
    !attempt.signInTokenId ||
    !attempt.tokenMintedAt ||
    !attempt.clerkUserId
  )
    return { outcome: "refused", reason: "unknown" }
  const refuse = async (
    reason: Exclude<BindOutcome, { outcome: "bound" }>["reason"],
  ) => {
    await d.store.record(attempt.tenantId, {
      type: "session.bind_failed",
      subjectUserId: attempt.clerkUserId,
      connectionId: attempt.connectionId,
      sessionId: input.sessionId,
      reason,
      data: { attemptId: attempt.id },
    })
    return { outcome: "refused" as const, reason }
  }
  if (attempt.boundAt) return refuse("used")
  if (now.getTime() - attempt.tokenMintedAt.getTime() > BIND_WINDOW_MS)
    return refuse("expired")
  if (attempt.clerkUserId !== input.userId) return refuse("wrong_user")

  const session = await d.clerk.session(input.sessionId)
  if (
    !session ||
    session.userId !== input.userId ||
    session.status !== "active" ||
    session.createdAt.getTime() < attempt.tokenMintedAt.getTime() - CLOCK_SKEW_MS
  )
    return refuse("session_mismatch")
  if ((await d.clerk.lastStrategy(session.clientId)) !== "ticket")
    return refuse("not_ticket")
  if ((await d.clerk.revokeSignInToken(attempt.signInTokenId)) !== "not_revocable")
    return refuse("token_not_accepted")

  if (!(await d.store.markBound(attempt.tenantId, attempt.id, input.sessionId, now)))
    return refuse("used")
  await d.store.bindSession(attempt.tenantId, {
    sessionId: input.sessionId,
    clerkUserId: input.userId,
    connectionId: attempt.connectionId,
    identityId: attempt.identityId,
    idpSession: attempt.idpSession,
    authTime: attempt.authTime,
    at: now,
    // ⚠ FRESH AS OF THE IdP's OWN auth_time, NOT THE BIND. An IdP that signed
    // the person in from a day-old session of its own proved nothing recent;
    // no auth_time at all proves nothing, so it is the epoch.
    freshAt: attempt.authTime ?? new Date(0),
  })
  await d.store.record(attempt.tenantId, {
    type: "sign_in.succeeded",
    subjectUserId: input.userId,
    connectionId: attempt.connectionId,
    sessionId: input.sessionId,
    data: { attemptId: attempt.id },
  })
  return { outcome: "bound", returnTo: attempt.returnTo }
}
