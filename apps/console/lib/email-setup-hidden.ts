import { cookies } from "next/headers"

/**
 * "Not now" on the setup card, for as long as this browser stays open.
 *
 * ⚠ A SESSION COOKIE, NOT A PERMANENT CHOICE. The card is how someone with an
 * empty workspace learns what is left to do, and the brief is that it comes back
 * until setup is done. Hiding it is a way to get it out of the way for now, so
 * the cookie has no `maxAge` and goes when the browser does.
 *
 * ⚠ THE VALUE IS THE TENANT ID, for the reason lib/onboarding-skip.ts gives: the
 * question is about a workspace, and a bare flag would hide the card in every
 * workspace this browser opens next.
 *
 * ⚠ A COOKIE AND NOT BROWSER STORAGE SO THE SERVER KNOWS. The page decides
 * whether to draw the card; with storage it would draw it, then remove it, and a
 * card that blinks in on every visit after being hidden reads as broken.
 */
const COOKIE = "i10_email_setup_hidden"

export async function hasHiddenEmailSetup(tenantId: string): Promise<boolean> {
  return (await cookies()).get(COOKIE)?.value === tenantId
}

export async function rememberHiddenEmailSetup(tenantId: string): Promise<void> {
  ;(await cookies()).set(COOKIE, tenantId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    // ⚠ NOT SECURE IN DEVELOPMENT: a `Secure` cookie is dropped over plain http,
    // which would make "Hide for now" do nothing on the machine it is tested on.
    secure: process.env.NODE_ENV === "production",
  })
}

export async function forgetHiddenEmailSetup(): Promise<void> {
  ;(await cookies()).delete(COOKIE)
}
