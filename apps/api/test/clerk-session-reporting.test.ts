import { describe, expect, it } from "bun:test"
import { clerkActiveOrg, clerkSessions } from "../src/middleware/session.js"
import type { ClerkClient } from "@clerk/backend"

/**
 * What happens when Clerk throws.
 *
 * ⚠ THIS FILE EXISTS BECAUSE THE SILENT VERSION COST A PRODUCTION OUTAGE.
 * `authenticateRequest` throws for reasons that are OURS at least as often as
 * theirs — a missing publishable key, a secret from the wrong instance, a
 * malformed token — and the verifier catches all of them and reports
 * `unavailable`. That flattening is correct for the OUTCOME: we do not know
 * whether the session is good, so we must not answer 401. It was catastrophic
 * for DIAGNOSIS: `CLERK_PUBLISHABLE_KEY` was unset on the API, every console
 * page rendered "Could not verify your session right now. Retry shortly.", and
 * the API log contained not one line about it.
 *
 * So the outcome is pinned AND the reporting is pinned. Either one alone is the
 * bug: dropping the log brings the outage back, and changing the outcome would
 * answer 401 during a real Clerk outage and sign everybody out.
 */

/** A client whose `authenticateRequest` throws, as Clerk's does when unwired. */
const throwing = (message: string) =>
  ({
    authenticateRequest: async () => {
      throw new Error(message)
    },
  }) as unknown as ClerkClient

const request = () =>
  new Request("https://api.i10.tech/console/me", {
    headers: { Authorization: "Bearer stub" },
  })

const collect = () => {
  const lines: { fields: object; message: string }[] = []
  return {
    lines,
    log: {
      error: (fields: object, message: string) => lines.push({ fields, message }),
    },
  }
}

describe("clerkSessions", () => {
  it("reports the reason and still answers unavailable", async () => {
    const { lines, log } = collect()

    const outcome = await clerkSessions(throwing("Publishable key is missing."), {
      log,
    }).verify(request())

    // ⚠ THE OUTCOME IS UNCHANGED. `requireTenant` turns this into a 503 with a
    // Retry-After, which is the only safe answer when verification did not
    // complete — a 401 here signs somebody out during somebody else's outage.
    expect(outcome).toEqual({ status: "unavailable" })

    // ⚠ AND THE REASON SURVIVES. "Publishable key is missing" in a log line is
    // a five-minute fix; the same condition with no log is an afternoon.
    expect(lines).toHaveLength(1)
    expect(String(lines[0]?.fields)).toBeDefined()
    expect(JSON.stringify(lines[0]?.fields)).toContain("Publishable key is missing")
    expect(lines[0]?.message).toContain("CLERK_PUBLISHABLE_KEY")
  })

  /**
   * ⚠ THE LOGGER IS OPTIONAL, AND ITS ABSENCE MUST NOT THROW. Every test in
   * this suite and the OpenAPI generator build a verifier without one; a
   * required logger would turn "no logging configured" into a crash on the
   * authentication path.
   */
  it("does not require a logger", async () => {
    const outcome = await clerkSessions(throwing("boom")).verify(request())
    expect(outcome).toEqual({ status: "unavailable" })
  })
})

describe("clerkActiveOrg", () => {
  /**
   * ⚠ THE SAME TREATMENT, BECAUSE IT HAS THE SAME FAILURE MODE. `unknown` is
   * also rendered as a 503, so an unset variable here would present as an
   * intermittent Clerk problem rather than as our own configuration.
   */
  it("reports the reason and still answers unknown", async () => {
    const { lines, log } = collect()

    const outcome = await clerkActiveOrg(throwing("Publishable key is missing."), {
      log,
    })(request())

    expect(outcome).toEqual({ status: "unknown" })
    expect(lines).toHaveLength(1)
    expect(lines[0]?.message).toContain("organization")
  })
})
