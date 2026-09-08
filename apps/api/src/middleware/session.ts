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
      } catch {
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
