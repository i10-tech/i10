import type { MiddlewareHandler } from "hono"
import type { ClerkClient } from "@clerk/backend"

/**
 * Signed-in-person authentication, alongside the API key.
 *
 * ⚠ TWO CREDENTIALS, TWO AUDIENCES, AND THEY MUST NOT BE INTERCHANGEABLE. An
 * API key is a machine credential a customer pastes into a server to send
 * transactional mail; a session belongs to a human sitting in the console. The
 * routes that create a HUMAN mailbox take the session only. Accepting a key
 * there would mean a leaked sending key could mint mailboxes on the customer's
 * domain — a credential whose whole advertised blast radius is "can send mail"
 * would quietly also be "can read mail", and key rotation would not undo it.
 *
 * ⚠ AND A SESSION IS NEVER ACCEPTED ON THE SENDING ROUTES EITHER. Those are
 * called from customers' servers with no browser and no origin; letting a
 * cookie authenticate them is how a page on another site sends mail as the
 * signed-in customer.
 */

export interface SessionContext {
  /** Clerk's `user_…`. The subject authd delegates binds for. */
  userId: string
}

export type SessionOutcome =
  | { status: "signed-in"; userId: string }
  | { status: "signed-out" }
  /** Clerk did not answer. See the 503 below. */
  | { status: "unavailable" }

export interface SessionVerifier {
  verify(request: Request): Promise<SessionOutcome>
}

export interface ClerkSessionOptions {
  /**
   * Where a verification failure is reported.
   *
   * ⚠ WITHOUT IT A MISCONFIGURATION IS INDISTINGUISHABLE FROM A CLERK OUTAGE,
   * and that cost a production debugging session. `authenticateRequest` throws
   * for reasons that are OURS as often as theirs — a missing publishable key,
   * a malformed secret, a key from the wrong instance — and this catch turns
   * every one of them into the same `unavailable`, which `requireTenant`
   * renders as "Could not verify your session right now. Retry shortly." That
   * message is correct for an outage and actively misleading for a variable
   * nobody set: it says wait, when the answer is that waiting will never help.
   * The console showed it on every page and the API log said nothing at all.
   */
  log?: { error: (o: object, m: string) => void }
  /**
   * The origins allowed to present a session here.
   *
   * ⚠ EMPTY MEANS CLERK CHECKS NOTHING, which is why this is threaded through
   * rather than left to the default. `azp` is what stops a token minted for
   * some other application on the same Clerk instance from being replayed
   * against this API.
   */
  authorizedParties?: readonly string[]
}

export function clerkSessions(
  clerk: ClerkClient,
  options: ClerkSessionOptions = {},
): SessionVerifier {
  const authorizedParties = options.authorizedParties?.length
    ? [...options.authorizedParties]
    : undefined

  return {
    async verify(request) {
      try {
        const state = await clerk.authenticateRequest(request, { authorizedParties })
        if (!state.isAuthenticated) return { status: "signed-out" }

        const { userId } = state.toAuth()
        // ⚠ A MACHINE TOKEN AUTHENTICATES WITH NO USER BEHIND IT. Clerk's
        // request state covers more than browser sessions, and those carry no
        // `userId`. Treating that as signed-in would hand provisioning an
        // undefined subject to create a mailbox for.
        return userId ? { status: "signed-in", userId } : { status: "signed-out" }
      } catch (error) {
        /*
         * ⚠ REPORTED BEFORE IT IS FLATTENED. The outcome stays `unavailable`,
         * because the CALLER's decision is the same either way — never answer
         * 401 when we do not know whether the session is good. What changes is
         * that the reason survives: "Publishable key is missing" in a log line
         * is a five-minute fix, and the same condition with no log is an
         * afternoon spent looking at Clerk's status page.
         *
         * ⚠ AND IT IS `error`, NOT `warn`. A session that cannot be verified
         * means nobody can use the console at all. That is not a degraded mode.
         */
        options.log?.error(
          { err: String(error) },
          "clerk could not verify a session — check CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY",
        )
        return { status: "unavailable" }
      }
    },
  }
}

/**
 * ⚠ THE 503 BRANCH IS THE SAME RULE `requireApiKey` FOLLOWS, and it matters
 * more here. A 401 tells someone their sign-in is bad; during a Clerk outage
 * they respond by signing out and finding they cannot sign back in. authd
 * answers LDAP `unavailable` rather than `invalidCredentials` for exactly this
 * reason.
 */
export const requireUser: MiddlewareHandler = async (c, next) => {
  const verifier = c.get("sessionAuth")
  if (!verifier) {
    return c.json(
      {
        statusCode: 501,
        name: "internal_server_error",
        message: "Session verification is not wired up yet.",
      },
      501,
    )
  }

  const outcome = await verifier.verify(c.req.raw)

  switch (outcome.status) {
    case "signed-in":
      c.set("user", { userId: outcome.userId })
      await next()
      return

    case "signed-out":
      return c.json(
        {
          statusCode: 401,
          name: "invalid_access",
          message: "Sign in to manage mailboxes.",
        },
        401,
      )

    default:
      c.header("Retry-After", "5")
      return c.json(
        {
          statusCode: 503,
          name: "service_unavailable",
          message: "Could not verify your session right now. Retry shortly.",
        },
        503,
      )
  }
}

/**
 * The active organization on a verified session, if there is one.
 *
 * ⚠ A SECOND, SEPARATE READER RATHER THAN A WIDER `SessionOutcome`, AND THE
 * SEPARATION IS THE POINT. `SessionVerifier` was built for `/mailboxes`, where
 * the organization is irrelevant — and a field on that interface is a field
 * every existing caller can suddenly authorise against. Keeping the org behind
 * its own function means only `requireTenant` can see it, which is the only
 * thing that should.
 *
 * ⚠ IT RE-AUTHENTICATES RATHER THAN THREADING STATE THROUGH, WHICH COSTS
 * NOTHING. `authenticateRequest` verifies a JWT locally against Clerk's cached
 * JWKS — there is no network call on the common path — so calling it twice on
 * one request is two signature checks, not two round trips. Threading the state
 * object out of `verify()` would mean widening the interface, which is the
 * thing this exists to avoid.
 *
 * ⚠ AND THE ANSWER IS THREE-STATE, BECAUSE "NO ORGANIZATION" AND "WE COULD NOT
 * TELL" ARE DIFFERENT FACTS WITH DIFFERENT CONSEQUENCES. `tenant_for_principal`
 * reads a null org as "use the personal tenant" — see 0038 — so collapsing a
 * failure into null does not degrade gracefully, it SILENTLY SWITCHES WORKSPACE.
 * Somebody working in their company account would, for the duration of a Clerk
 * hiccup, mint an API key into their personal tenant, rename the wrong
 * workspace, or start a checkout billing the wrong one — and every page would
 * look plausible, because the personal tenant is a real tenant with real data.
 * `unknown` lets `requireTenant` answer 503 and refuse to guess.
 */
export type ActiveOrgOutcome =
  /** A session with an organization activated. */
  | { status: "org"; orgId: string }
  /** A verified session with no organization activated — the personal tenant. */
  | { status: "personal" }
  /** Clerk did not answer, or contradicted the verification. Do NOT guess. */
  | { status: "unknown" }

export type ActiveOrgReader = (request: Request) => Promise<ActiveOrgOutcome>

export function clerkActiveOrg(
  clerk: ClerkClient,
  options: ClerkSessionOptions = {},
): ActiveOrgReader {
  const authorizedParties = options.authorizedParties?.length
    ? [...options.authorizedParties]
    : undefined

  return async (request) => {
    try {
      const state = await clerk.authenticateRequest(request, { authorizedParties })
      /*
       * ⚠ NOT-AUTHENTICATED HERE IS A CONTRADICTION, NOT A SIGN-OUT. The same
       * request was verified signed-in moments ago by `SessionVerifier`; if the
       * second check disagrees, something is wrong with Clerk rather than with
       * the caller. Reporting `personal` would be the silent workspace switch
       * described above, so this is `unknown` and the request fails loudly.
       */
      if (!state.isAuthenticated) return { status: "unknown" }
      const auth = state.toAuth()
      // `orgId` is present only on a session that has ACTIVATED an organization.
      // A user who belongs to three and has activated none has none here, and
      // that is the correct input to `tenant_for_principal` — see 0038.
      const orgId = (auth as { orgId?: string | null }).orgId
      return typeof orgId === "string" && orgId
        ? { status: "org", orgId }
        : { status: "personal" }
    } catch (error) {
      // ⚠ THE SAME REPORTING, FOR THE SAME REASON — see `clerkSessions`. This
      // one answers 503 too, so an unset variable would otherwise present as an
      // intermittent Clerk problem rather than as our own configuration.
      options.log?.error(
        { err: String(error) },
        "clerk could not resolve the active organization",
      )
      return { status: "unknown" }
    }
  }
}
