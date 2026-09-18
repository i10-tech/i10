import { cookies } from "next/headers"

/**
 * "I have seen the set-up flow, let me into the console."
 *
 * ⚠ THIS EXISTS BECAUSE "Skip to the console" DID NOTHING AT ALL. The link
 * pointed at `/`, the app layout redirects to `/onboarding` whenever
 * `should_onboard` is true, and that flag stays true until a domain is verified
 * — so the skip went to the console and was bounced straight back, landing
 * exactly where it started. The button looked broken because, from where
 * somebody was sitting, it was.
 *
 * ⚠ A COOKIE RATHER THAN MARKING ONBOARDING COMPLETE, AND THE DIFFERENCE
 * MATTERS. `complete` stamps `completed_at` and `last_onboarded_plan`, which is
 * what re-opens the flow after an upgrade and what the product reads to know
 * whether somebody ever finished. Writing that on a *skip* would record a
 * set-up they did not do, permanently, to serve a preference that belongs to
 * this browser. Skipping is a view preference; finishing is a fact.
 *
 * ⚠ AND IT IS SHORT-LIVED ON PURPOSE. Somebody who skips today should still be
 * met by the flow next week if they never finished it — the whole point of the
 * redirect is that an account with no verified domain cannot send, and quietly
 * forgetting to mention that for ever is not a kindness. A week is long enough
 * that the skip is not nagging and short enough that it is not a dead end.
 *
 * ⚠ THE VALUE IS THE TENANT ID, NOT `"1"`, AND THAT IS A FIX RATHER THAN A
 * REFINEMENT. A bare flag is a claim about the BROWSER, but the question being
 * asked is about a WORKSPACE — so one skip suppressed the flow for every
 * workspace that browser went on to see, for a week. The reproduction is
 * ordinary: skip once, sign up again with a different account, and the new
 * workspace lands on an empty dashboard having never been offered the flow that
 * exists to tell it that a tenant with no verified domain cannot send anything.
 * A brand new workspace must always be asked, whatever the last one chose.
 */
const COOKIE = "i10_onboarding_skipped"
const A_WEEK = 60 * 60 * 24 * 7

export async function hasSkippedOnboarding(tenantId: string): Promise<boolean> {
  return (await cookies()).get(COOKIE)?.value === tenantId
}

export async function rememberOnboardingSkip(tenantId: string): Promise<void> {
  ;(await cookies()).set(COOKIE, tenantId, {
    maxAge: A_WEEK,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    // ⚠ NOT SECURE IN DEVELOPMENT, OR THE SKIP SILENTLY FAILS ON `localhost`.
    // A `Secure` cookie is dropped over plain http, so the button would go back
    // to doing nothing on exactly the machine somebody tests it on.
    secure: process.env.NODE_ENV === "production",
  })
}

export async function forgetOnboardingSkip(): Promise<void> {
  ;(await cookies()).delete(COOKIE)
}
