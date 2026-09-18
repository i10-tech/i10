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
 */
const COOKIE = "i10_onboarding_skipped"
const A_WEEK = 60 * 60 * 24 * 7

export async function hasSkippedOnboarding(): Promise<boolean> {
  return (await cookies()).get(COOKIE)?.value === "1"
}

export async function rememberOnboardingSkip(): Promise<void> {
  ;(await cookies()).set(COOKIE, "1", {
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
