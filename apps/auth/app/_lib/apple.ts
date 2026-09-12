import "server-only"

/**
 * Whether to offer "Continue with Apple".
 *
 * ⚠ DECIDED ON THE SERVER FROM THE REQUEST'S User-Agent, NOT IN THE BROWSER.
 * A client-side check cannot run until React has hydrated, so the button would
 * either be absent for a moment and then appear — moving every control below it
 * while somebody is reaching for one — or be present and then vanish. Both
 * pages are already `force-dynamic` because they read the query string, so
 * reading a header costs nothing extra and the first paint is already correct.
 *
 * ⚠ USER-AGENT SNIFFING, WHICH IS NORMALLY THE WRONG ANSWER, and is defensible
 * here only because being wrong costs one extra button rather than a broken
 * flow. Apple's own guidance is that Sign in with Apple belongs on Apple
 * platforms; a Windows machine seeing it is noise, and an iPhone missing it is
 * the one thing worth avoiding — so the test errs toward showing it.
 *
 * ⚠ THE TOKENS ARE THE PLATFORM ONES, NOT `Apple` ANYWHERE IN THE STRING.
 * Every Chromium and WebKit browser on every platform carries `AppleWebKit`,
 * so matching that would put the button on Android and Windows too. Only
 * `Macintosh`, `Mac OS X`, `iPhone`, `iPad` and `iPod` name the hardware — and
 * an iPad reporting itself as a Mac is still an Apple device, so the
 * desktop-class iPadOS user agent is right by accident rather than missed.
 */
const APPLE_PLATFORM = /\b(?:Macintosh|Mac OS X|iPhone|iPad|iPod)\b/

export function isAppleUserAgent(userAgent: string | null | undefined): boolean {
  return userAgent ? APPLE_PLATFORM.test(userAgent) : false
}
