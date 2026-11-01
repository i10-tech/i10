/**
 * Where to send the browser when the API asks for the company's sign-in
 * (#337, #340): a start URL from an API answer, with this page as the return.
 *
 * ⚠ THE URL ARRIVES IN AN API ANSWER, SO IT IS FOLLOWED ONLY ON apps/auth'S OWN
 * ORIGIN AND ONLY TO THE ONE ROUTE THE CALLER EXPECTS. The access gate follows
 * `/sso/start`, the step-up `/sso/step-up`; anything else is null and the
 * caller says why instead of navigating.
 *
 * Pure and import-free: the gate, the step-up provider and the tests share it.
 */
export type SsoRoute = "/sso/start" | "/sso/step-up"

export function ssoStartHref(
  startUrl: unknown,
  authOrigin: string | null,
  route: SsoRoute,
  here: string,
): string | null {
  if (typeof startUrl !== "string" || !authOrigin) return null
  let url: URL
  try {
    url = new URL(startUrl)
  } catch {
    return null
  }
  if (url.origin !== authOrigin || url.pathname !== route) return null
  url.searchParams.set("redirect_url", here)
  return url.toString()
}

/**
 * The step-up refusal of a session that came through the company's IdP: the
 * API answers 403 `sso_step_up_required` with the URL that re-proves it there
 * (see `requireFreshAuth`). Null for any other answer.
 */
export function ssoStepUpOf(
  body: unknown,
): { message: string; startUrl: unknown } | null {
  if (!body || typeof body !== "object") return null
  const { name, message, startUrl } = body as Record<string, unknown>
  if (name !== "sso_step_up_required") return null
  return {
    message:
      typeof message === "string"
        ? message
        : "Sign in with your company's SSO again before doing this.",
    startUrl,
  }
}
