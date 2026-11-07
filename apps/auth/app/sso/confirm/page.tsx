import type { Metadata } from "next"
import { Button } from "@repo/ui/components/button/button"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { StepHeading } from "../../_components/step-heading"
import { callApi } from "../../_lib/devices-server"
import { loadInterstitial } from "../../_lib/sso-server"

export const metadata: Metadata = {
  title: "Sign in · i10",
  referrer: "no-referrer",
}

export const dynamic = "force-dynamic"

/**
 * Same-origin interstitial for SSO starts arriving from outside our sites
 * (IdP dashboard tiles, OIDC third-party initiated login, mail or chat links,
 * and IdP logout redirects).
 *
 * ⚠ NEVER AUTO-SUBMITTED WITH SCRIPT. The person's click on our own origin
 * sends `POST /sso/start` with `Sec-Fetch-Site: same-origin`, which is what
 * stops a hostile page from starting a sign-in into an attacker-chosen
 * connection in the visitor's browser (login CSRF).
 *
 * ⚠ THE CONNECTION NAME COMES FROM THE API, NEVER THE URL, so a link cannot
 * dress one workspace's connection up as another's.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const view = await loadInterstitial(await searchParams, (path, body) =>
    callApi(path, body),
  )

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 pt-24 pb-12">
      <div className="w-full max-w-sm">
        {view.state === "confirm" ? (
          <div className="flex flex-col items-center gap-6">
            <StepHeading title={view.title}>
              {view.loginHint
                ? `Sign in to i10 as ${view.loginHint} with ${view.name}.`
                : `Sign in to i10 with ${view.name}.`}
            </StepHeading>
            <form method="POST" action="/sso/start" className="w-full">
              <input type="hidden" name="connection" value={view.connection} />
              {view.returnTo ? (
                <input type="hidden" name="redirect_url" value={view.returnTo} />
              ) : null}
              {view.loginHint ? (
                <input type="hidden" name="login_hint" value={view.loginHint} />
              ) : null}
              {view.iss !== null ? (
                <input type="hidden" name="iss" value={view.iss} />
              ) : null}
              <Button type="submit" className="w-full">
                Continue
              </Button>
            </form>
          </div>
        ) : view.state === "invalid" ? (
          <div className="flex flex-col items-center gap-6">
            <StepHeading title="This sign-in link is not valid">
              Ask your administrator for a current sign-in link, or sign in from i10.
            </StepHeading>
            <ButtonLink href="/sign-in" variant="secondary" className="w-full">
              Back to sign in
            </ButtonLink>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-6">
            <StepHeading title="Could not sign you in">
              Sign-in is temporarily unavailable. Try again in a moment.
            </StepHeading>
            <ButtonLink href="/sign-in" variant="secondary" className="w-full">
              Back to sign in
            </ButtonLink>
          </div>
        )}
      </div>
    </main>
  )
}
