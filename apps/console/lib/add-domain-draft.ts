/**
 * Where somebody is in adding a domain, so a reload puts them back on the same
 * step with the same answers (2026-10-03).
 *
 * ⚠ A COOKIE, NOT THE URL AND NOT `sessionStorage`, for the reasons
 * ./onboarding-step.ts gives: the URL is the page, not this browser's progress
 * through it, and the server renders the step - a value only the browser could
 * see would paint step one and then jump to step three.
 *
 * ⚠ KEYED TO THE WORKSPACE AND SCOPED TO `/domains/new`, and a session cookie,
 * so a draft never follows somebody into another workspace or outlives the
 * browser.
 *
 * ⚠ IT LIVES AS LONG AS THE FLOW IS ON SCREEN, AND A RELOAD IS THE ONLY THING
 * IT SURVIVES (2026-10-03). Leaving - for the domain list to tidy up, through
 * the rail, by any link - forgets it, so the next "Add domain" is a new domain
 * and not the half-finished one from before. The shell does it on every route
 * change to anywhere else (see PageFrame), which a reload is not.
 *
 * ⚠ NOT AN UNMOUNT CLEANUP IN THE FORM. The leaving page is held on screen for
 * its exit animation and only unmounts when that ends - so the cleanup ran
 * late, and never at all where animation frames were paused, and the next
 * "Add domain" could be rendered from a draft that should have been gone.
 *
 * ⚠ ONLY WHAT WAS TYPED AND CHOSEN, AND THE CREATED ROW'S ID - NEVER THE ROW.
 * The records are read again from the API on the reload, so a draft can never
 * show records that have changed, or a domain that has been deleted since.
 */

export const ADD_DOMAIN_DRAFT_COOKIE = "i10_add_domain"

/**
 * The two places the domain steps run, each with its own draft (2026-10-04).
 *
 * ⚠ SET-UP REMEMBERS ITS DOMAIN STEPS TOO, IN A COOKIE OF ITS OWN. They are the
 * same steps as /domains/new, and losing them on a reload - a domain already
 * made, the person back at an empty name box, re-adding refused as a
 * duplicate - is the same failure. Separate names and paths, so neither page
 * ever resumes the other's half-finished domain.
 */
export type DraftScope = "page" | "onboarding"

export const DRAFT_COOKIES: Record<DraftScope, { name: string; path: string }> = {
  page: { name: ADD_DOMAIN_DRAFT_COOKIE, path: "/domains/new" },
  onboarding: { name: "i10_onboarding_domain", path: "/onboarding" },
}

export type DraftStep = "domain" | "records" | "publish"

export interface AddDomainDraft {
  name: string
  returnPath: string
  mode: "delegate" | "manual"
  advanced: boolean
  step: DraftStep
  /** The domain made at the second step, once it exists. */
  id?: string
}

const STEPS: DraftStep[] = ["domain", "records", "publish"]

/**
 * Reads the draft for this workspace, or nothing.
 *
 * ⚠ EVERY FIELD IS CHECKED, BECAUSE A COOKIE IS INPUT. It is ours, but anybody
 * can edit their own cookies, and a malformed one must start the flow over
 * rather than render a step built from garbage.
 */
export function draftFor(
  raw: string | undefined,
  tenantId: string,
): AddDomainDraft | null {
  if (!raw || !tenantId) return null
  try {
    const value = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>
    if (value.t !== tenantId) return null
    if (typeof value.name !== "string" || value.name.length > 253) return null
    if (typeof value.returnPath !== "string" || value.returnPath.length > 63)
      return null
    if (value.mode !== "delegate" && value.mode !== "manual") return null
    if (!STEPS.includes(value.step as DraftStep)) return null
    if (
      value.id !== undefined &&
      (typeof value.id !== "string" || value.id.length > 64)
    )
      return null
    return {
      name: value.name,
      returnPath: value.returnPath,
      mode: value.mode,
      advanced: value.advanced === true,
      step: value.step as DraftStep,
      ...(typeof value.id === "string" ? { id: value.id } : {}),
    }
  } catch {
    return null
  }
}

/** Browser only: remembers the draft, or forgets it with `null`. */
export function rememberDraft(
  tenantId: string,
  draft: AddDomainDraft | null,
  scope: DraftScope = "page",
): void {
  const { name: cookie, path: where } = DRAFT_COOKIES[scope]
  const path = `; path=${where}; samesite=lax`
  const secure = window.location.protocol === "https:" ? "; secure" : ""
  document.cookie =
    draft === null || !tenantId
      ? `${cookie}=${path}; max-age=0${secure}`
      : `${cookie}=${encodeURIComponent(
          JSON.stringify({ t: tenantId, ...draft }),
        )}${path}${secure}`
}

/**
 * Browser only: whether a draft cookie is still set.
 *
 * ⚠ FOR THE ROUTER'S REPLAYS. Back/forward can restore this page's server
 * render from the client cache, draft and all, after leaving has forgotten
 * it; the form checks this before trusting what it was handed.
 */
export function draftStillSet(scope: DraftScope = "page"): boolean {
  const cookie = DRAFT_COOKIES[scope].name
  return document.cookie
    .split("; ")
    .some((c) => c.startsWith(`${cookie}=`) && c.length > cookie.length + 1)
}

/** Browser only: forgets any draft, whichever workspace it belongs to. */
export function forgetDraft(): void {
  const secure = window.location.protocol === "https:" ? "; secure" : ""
  document.cookie = `${ADD_DOMAIN_DRAFT_COOKIE}=; path=/domains/new; samesite=lax; max-age=0${secure}`
}
