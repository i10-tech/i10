/**
 * Which onboarding step this browser was last on, so a reload or a return from
 * checkout or a DNS provider lands on the same one.
 *
 * ⚠ A COOKIE, NOT THE URL. The step used to ride in `?step=`, which put it in
 * the address bar, in history and in every link somebody copied out of set-up.
 * The URL is the page; which step of it you were on is this browser's memory.
 *
 * ⚠ AND A COOKIE RATHER THAN `sessionStorage`, BECAUSE THE SERVER HAS TO READ
 * IT. The page renders the step on the server; a value only the browser could
 * see would render the derived step first and then jump to the remembered one.
 *
 * ⚠ KEYED TO THE WORKSPACE, like the skip cookie in ./onboarding-skip.ts, so a
 * step remembered in one workspace is never applied to another. A session
 * cookie — no max-age — so a closed browser starts from the facts again.
 */

export const ONBOARDING_STEP_COOKIE = "i10_onboarding_step"

/** Reads `tenantId:step`, answering the step only for this workspace. */
export function stepFor(raw: string | undefined, tenantId: string): string | null {
  if (!raw || !tenantId) return null
  const cut = raw.lastIndexOf(":")
  return cut > 0 && raw.slice(0, cut) === tenantId ? raw.slice(cut + 1) : null
}

/** Browser only: remembers the step, or forgets it with `null`. */
export function rememberStep(tenantId: string, step: string | null): void {
  const path = "; path=/onboarding; samesite=lax"
  const secure = window.location.protocol === "https:" ? "; secure" : ""
  document.cookie =
    step === null || !tenantId
      ? `${ONBOARDING_STEP_COOKIE}=${path}; max-age=0${secure}`
      : `${ONBOARDING_STEP_COOKIE}=${encodeURIComponent(`${tenantId}:${step}`)}${path}${secure}`
}
