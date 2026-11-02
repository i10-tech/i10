import type { Engine } from "./bridge.js"
import { normaliseEmail, type Assertion, type GroupsState } from "./model.js"

/**
 * The TEST protocol (#337): an engine with no IdP behind it, so the whole
 * bridge (attempt, completion, handoff, ticket, bind, gate) can be driven end
 * to end on the Clerk dev instance.
 *
 * ⚠ IT VERIFIES NOTHING, BY DESIGN, SO EVERYTHING AROUND IT IS A LOCK:
 *
 *   1. env.ts refuses `IDENTITY_TEST_ENGINE=on` when NODE_ENV is production,
 *      and unless CLERK_SECRET_KEY is a dev instance's `sk_test_` key.
 *   2. Off, it is not in the engine map: a `test` connection cannot be
 *      created (`creatable`), started, or completed (`completeLogin` refuses
 *      a protocol it has no engine for), and `POST /sso/test/assert` is 404.
 *   3. On, it can only finish an attempt this browser started (the state in
 *      the URL plus the binding cookie), and the bridge's own rules all still
 *      apply: the asserted email must be on a live verified domain of the
 *      workspace, the account must exist, and so on. What it skips is only
 *      the question an engine answers - "did the IdP really say this?"
 */

export function testEngineOn(env: {
  IDENTITY_TEST_ENGINE: "on" | "off"
  NODE_ENV: string
  CLERK_SECRET_KEY: string
}): boolean {
  // ⚠ RE-CHECKED HERE, NOT ONLY IN env.ts: a refactor that loads the
  // environment some other way must not quietly turn this on in production.
  return (
    env.IDENTITY_TEST_ENGINE === "on" &&
    env.NODE_ENV !== "production" &&
    env.CLERK_SECRET_KEY.startsWith("sk_test_")
  )
}

/** The engine: its "IdP" is a dev page on apps/auth that asks for a subject and email. */
export function testEngine(authOrigin: string): Engine {
  return {
    protocol: "test",
    pkce: false,
    async begin(_connection, attempt) {
      const url = new URL("/sso/test", authOrigin)
      url.searchParams.set("state", attempt.state)
      return { redirectUrl: url.href }
    },
  }
}

/**
 * What the dev page posts, as an assertion. `authTime` is now: the person at
 * the dev page just "authenticated".
 */
export function testAssertion(body: unknown, now: Date = new Date()): Assertion | null {
  const b = (body ?? {}) as Record<string, unknown>
  const subject = typeof b.subject === "string" ? b.subject.trim() : ""
  const email = normaliseEmail(typeof b.email === "string" ? b.email : null)
  if (!subject || subject.length > 256 || !email) return null
  const amr = Array.isArray(b.amr)
    ? b.amr.filter((v): v is string => typeof v === "string").slice(0, 8)
    : ["pwd"]
  const groups = Array.isArray(b.groups)
    ? b.groups.filter((v): v is string => typeof v === "string").slice(0, 50)
    : []
  const groupsState: GroupsState =
    b.groupsState === "present" ||
    b.groupsState === "absent" ||
    b.groupsState === "overage"
      ? b.groupsState
      : Array.isArray(b.groups)
        ? "present"
        : "absent"
  return {
    subject,
    email,
    emailVerified: b.emailVerified !== false,
    givenName: typeof b.givenName === "string" ? b.givenName : null,
    familyName: typeof b.familyName === "string" ? b.familyName : null,
    groups,
    groupsState,
    amr,
    authTime: now,
    idpSession: typeof b.idpSession === "string" ? b.idpSession.slice(0, 256) : null,
  }
}
