import { describe, expect, it } from "bun:test"
import { shouldOnboard } from "../src/console/onboarding.js"

/**
 * Whether the console redirects somebody into the set-up flow.
 *
 * ⚠ THIS IS PURE FOR EXACTLY THIS REASON. The rule has four inputs and a
 * surprising shape — re-run on upgrade FROM free, never on paid → paid, and
 * never at all for somebody who set everything up through the API — and every
 * way of getting it wrong is a bad first impression that nobody reports. A
 * function with a database inside it could not be checked at this resolution.
 */
const facts = (overrides: Partial<Parameters<typeof shouldOnboard>[0]["facts"]> = {}) => ({
  has_domain: false,
  has_verified_domain: false,
  has_api_key: false,
  ...overrides,
})

describe("shouldOnboard", () => {
  it("sends a brand-new tenant to the flow", () => {
    expect(
      shouldOnboard({
        completedAt: null,
        lastOnboardedPlan: null,
        currentPlan: "free",
        facts: facts(),
        freePlanId: "free",
      }),
    ).toBe(true)
  })

  /**
   * ⚠ THE FACTS BEAT THE ROW, AND THIS IS THE CASE THAT MATTERS MOST. Somebody
   * who integrated entirely through the API has no onboarding row at all. The
   * naive reading — "no row means not onboarded" — would greet an established
   * customer with a wizard asking them to add their first domain.
   */
  it("does not send somebody who already has a verified domain and a key", () => {
    expect(
      shouldOnboard({
        completedAt: null,
        lastOnboardedPlan: null,
        currentPlan: "free",
        facts: facts({ has_domain: true, has_verified_domain: true, has_api_key: true }),
        freePlanId: "free",
      }),
    ).toBe(false)
  })

  it("still sends somebody with a verified domain but no key", () => {
    // Half set up is not set up: they cannot send.
    expect(
      shouldOnboard({
        completedAt: null,
        lastOnboardedPlan: null,
        currentPlan: "free",
        facts: facts({ has_domain: true, has_verified_domain: true }),
        freePlanId: "free",
      }),
    ).toBe(true)
  })

  it("does not send somebody who has finished", () => {
    expect(
      shouldOnboard({
        completedAt: new Date("2026-01-01"),
        lastOnboardedPlan: "free",
        currentPlan: "free",
        facts: facts({ has_domain: true }),
        freePlanId: "free",
      }),
    ).toBe(false)
  })

  /**
   * ⚠ THE UPGRADE RULE, IN BOTH DIRECTIONS. Moving off free unlocks domains,
   * mailboxes and storage that were previously zero, so there is genuinely
   * something new to set up. Moving between paid plans moves a number, and
   * interrupting somebody who has just paid us more to walk them through a
   * domain they configured six months ago is an insult dressed as a wizard.
   */
  it("re-runs after an upgrade FROM the free plan", () => {
    expect(
      shouldOnboard({
        completedAt: new Date("2026-01-01"),
        lastOnboardedPlan: "free",
        currentPlan: "pro",
        facts: facts({ has_domain: true }),
        freePlanId: "free",
      }),
    ).toBe(true)
  })

  it("does NOT re-run on an upgrade between two paid plans", () => {
    expect(
      shouldOnboard({
        completedAt: new Date("2026-01-01"),
        lastOnboardedPlan: "pro",
        currentPlan: "scale",
        facts: facts({ has_domain: true }),
        freePlanId: "free",
      }),
    ).toBe(false)
  })

  it("does NOT re-run on a downgrade back to free", () => {
    // Nothing is unlocked by losing allowance; there is nothing to set up.
    expect(
      shouldOnboard({
        completedAt: new Date("2026-01-01"),
        lastOnboardedPlan: "pro",
        currentPlan: "free",
        facts: facts({ has_domain: true }),
        freePlanId: "free",
      }),
    ).toBe(false)
  })

  /**
   * ⚠ THE UPGRADE RULE BEATS THE FACTS SHORTCUT, AND THIS TEST USED TO ASSERT
   * THE OPPOSITE. The reasoning behind the old order sounded right — somebody
   * with a verified domain and a live key does not need to be walked through
   * creating one — but it answers a question nobody asked. The flow that runs
   * after an upgrade ends on the plan screen: here is what you just bought, and
   * here is how much of it you have used. The person who most wants to see that
   * is precisely the established customer this shortcut was excluding, so the
   * fully-set-up tenant was the one case the upgrade flow never ran for.
   *
   * ⚠ AND `has_verified_domain && has_api_key` IS THE SHAPE OF AN ENGAGED
   * ACCOUNT, NOT AN EDGE CASE. Almost everybody who upgrades looks like this;
   * an upgrade flow that skips them is an upgrade flow that effectively does
   * not exist.
   */
  it("re-runs on upgrade even for a tenant that is fully set up", () => {
    expect(
      shouldOnboard({
        completedAt: new Date("2026-01-01"),
        lastOnboardedPlan: "free",
        currentPlan: "pro",
        facts: facts({ has_domain: true, has_verified_domain: true, has_api_key: true }),
        freePlanId: "free",
      }),
    ).toBe(true)
  })

  /**
   * ⚠ THE FACTS SHORTCUT STILL WINS EVERYWHERE ELSE, which is the half that
   * must not regress. Somebody who set everything up through the API and opens
   * the console for the first time has no onboarding row at all; greeting them
   * with a wizard asking for their first domain — the one they are already
   * sending from — is the failure that shortcut exists to prevent.
   */
  it("does not onboard an established tenant who has never opened the console", () => {
    expect(
      shouldOnboard({
        completedAt: null,
        lastOnboardedPlan: null,
        currentPlan: "pro",
        facts: facts({ has_domain: true, has_verified_domain: true, has_api_key: true }),
        freePlanId: "free",
      }),
    ).toBe(false)
  })

  /**
   * ⚠ `freePlanId` IS CONFIGURATION, NOT THE LITERAL "free". It comes from
   * `METERING_FREE_PLAN_ID`, and a deployment that renamed it would otherwise
   * silently never re-run the flow for anybody.
   */
  it("honours a renamed free plan", () => {
    expect(
      shouldOnboard({
        completedAt: new Date("2026-01-01"),
        lastOnboardedPlan: "starter",
        currentPlan: "pro",
        facts: facts({ has_domain: true }),
        freePlanId: "starter",
      }),
    ).toBe(true)
  })

  it("does not re-run when the plan cannot be read", () => {
    // A null current plan means we could not resolve one. Sending somebody into
    // set-up on the strength of a failed read would be a redirect loop for a
    // tenant whose plan assignment is momentarily unreadable.
    expect(
      shouldOnboard({
        completedAt: new Date("2026-01-01"),
        lastOnboardedPlan: "free",
        currentPlan: null,
        facts: facts({ has_domain: true }),
        freePlanId: "free",
      }),
    ).toBe(false)
  })
})
