import { redirect } from "next/navigation"
import { rememberOnboardingSkip } from "@/lib/onboarding-skip"

/**
 * Where "Skip to the console" actually goes.
 *
 * ⚠ A ROUTE RATHER THAN A `<Link href="/">`, BECAUSE THE LINK WAS THE BUG. The
 * console layout redirects to `/onboarding` while `should_onboard` is true, so
 * a plain link to `/` bounced the person straight back into the flow they had
 * just asked to leave. Something has to be written down between the click and
 * the console, and this is the smallest place to write it.
 *
 * ⚠ GET IS CORRECT HERE DESPITE WRITING A COOKIE. What it stores is this
 * browser's own view preference, not account state — nothing about the
 * workspace, the plan or the domains changes — so there is no cross-site
 * request worth forging, and `SameSite=Lax` already bounds it. Making it a POST
 * would cost a form and a client component for a link in a header.
 */
export async function GET() {
  await rememberOnboardingSkip()
  redirect("/")
}
