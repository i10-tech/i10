"use client"

import Link from "next/link"
import { useAuth, useClerk, useOAuthConsent, useUser } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { Field, FieldDescription, FieldGroup } from "@repo/ui/components/field"
import { Spinner } from "@repo/ui/components/spinner"

/*
 * The consent screen, as a custom flow.
 *
 * ⚠ IT IS A REAL <form> THAT POSTS TO CLERK, NOT A fetch() AND NOT A CLIENT
 * HANDLER, AND THAT IS THE ONE THING HERE THAT CANNOT BE REWRITTEN TO TASTE.
 * The endpoint answers with a 302 back to the requesting application's
 * `redirect_uri`, carrying the authorization code. A `fetch` would follow that
 * redirect in the background, hand us a response nobody can act on, and leave
 * the browser sitting on this page with the code spent. `buildConsentActionUrl`
 * exists precisely for this — Clerk documents it as the value for a form's
 * `action` when you build your own consent UI.
 *
 * ⚠ THE TWO BUTTONS ARE BOTH `type="submit"` AND DIFFER ONLY BY VALUE. Allow is
 * `consented=true`, deny is `consented=false`; the same endpoint handles both,
 * and denying is a real answer that has to reach the client application rather
 * than a "close the tab". Making deny a link or a router push would abandon the
 * request instead of refusing it, and the app that sent the person here would
 * hang waiting for a response that never comes.
 */
export function ConsentForm({
  clientId,
  scope,
  redirectUri,
  forwarded,
}: {
  clientId?: string
  scope?: string
  redirectUri?: string
  /** Every query parameter, re-emitted as hidden inputs — see page.tsx. */
  forwarded: [string, string][]
}) {
  const clerk = useClerk()
  const { isLoaded: userLoaded, isSignedIn, user } = useUser()
  const { orgId } = useAuth()

  const { data, error, isLoading } = useOAuthConsent({
    oauthClientId: clientId ?? "",
    scope,
    redirectUri,
  })

  // A link that arrives with no client_id is not an authorization request.
  if (!clientId) {
    return (
      <Notice title="That link is not complete">
        This page finishes signing in to another application, and the request it needs
        is missing. Start again from the application that sent you here.
      </Notice>
    )
  }

  if (!userLoaded || isLoading || !clerk.loaded) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <Spinner aria-hidden="true" aria-label={undefined} />
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    )
  }

  /*
   * ⚠ CLERK NORMALLY SIGNS SOMEBODY IN BEFORE SENDING THEM HERE, so this is the
   * expired-mid-flow case rather than the common one. The link keeps the whole
   * authorization request in `redirect_url` so approving can continue after
   * signing in — but see _lib/redirect.ts: that only works if this app's own
   * origin is in `AUTH_ALLOWED_REDIRECT_ORIGINS`. Without it the person lands
   * on the dashboard instead, which is safe and merely means starting over.
   */
  if (!isSignedIn) {
    return (
      <Notice title="Sign in to continue">
        <p>
          You need to be signed in to i10 before you can give another application access
          to your account.
        </p>
        <Link
          href={`/sign-in?redirect_url=${encodeURIComponent(window.location.href)}`}
          className="underline underline-offset-4"
        >
          Sign in
        </Link>
      </Notice>
    )
  }

  if (error || !data) {
    return (
      <Notice title="We could not load this request">
        {error?.errors?.[0]?.longMessage ??
          "Something went wrong. Start again from the application that sent you here."}
      </Notice>
    )
  }

  /*
   * ⚠ `offline_access` IS HIDDEN FROM THE LIST AND MENTIONED SEPARATELY, which
   * is what Clerk's own component does. It is not a thing the application reads
   * — it is a request to keep access working after the person closes the tab —
   * so listing it among "can read your…" permissions describes it wrongly.
   */
  const wantsOfflineAccess = data.scopes.some((s) => s.scope === "offline_access")
  const permissions = data.scopes.filter((s) => s.scope !== "offline_access")

  /*
   * ⚠ THE ORGANISATION IS SENT ONLY WHEN THE APPLICATION ASKED FOR IT. Clerk
   * gates this on the request carrying `user:org:read` with organisations
   * enabled; posting an organisation id the application never asked about would
   * widen the grant beyond what this screen described.
   *
   * ⚠ AND THERE IS NO ORGANISATION PICKER HERE, WHICH IS A KNOWN GAP. Clerk's
   * prebuilt screen lets somebody choose WHICH organisation to grant; this
   * sends the active one. Nothing requests `user:org:read` today, so the gap is
   * unreachable — but an application that does would silently get the active
   * organisation rather than a chosen one, and this needs building first.
   */
  const includeOrganization = permissions.some((s) => s.scope === "user:org:read")

  return (
    <form
      method="POST"
      action={clerk.oauthApplication.buildConsentActionUrl({ clientId })}
    >
      <FieldGroup>
        <div className="flex flex-col items-center gap-3 text-center">
          {data.oauthApplicationLogoUrl ? (
            /*
             * ⚠ A PLAIN <img> — the application's own logo, on whatever host
             * uploaded it. Routing a third party's arbitrary image through the
             * Next optimiser would mean allowing arbitrary remote patterns,
             * which is a far larger surface than one 48px mark.
             */
            // eslint-disable-next-line @next/next/no-img-element -- see above
            <img
              src={data.oauthApplicationLogoUrl}
              alt=""
              aria-hidden="true"
              className="size-12 rounded-lg"
            />
          ) : null}
          <h1 className="text-2xl font-bold text-balance">
            {data.oauthApplicationName} wants access to your account
          </h1>
          <p className="text-muted-foreground text-sm text-balance">
            Signed in as {user?.primaryEmailAddress?.emailAddress ?? "your account"}.
          </p>
        </div>

        {permissions.length > 0 ? (
          <Field>
            <p className="text-sm font-medium">It will be able to:</p>
            <ul className="text-muted-foreground flex list-disc flex-col gap-2 pl-5 text-sm">
              {permissions.map((permission) => (
                <li key={permission.scope}>
                  {permission.description ?? permission.scope}
                </li>
              ))}
            </ul>
          </Field>
        ) : null}

        {wantsOfflineAccess ? (
          <FieldDescription>
            It will keep this access until you revoke it, including while you are not
            using i10.
          </FieldDescription>
        ) : null}

        {/*
         * ⚠ THE DESTINATION IS SHOWN, AND ITS ABSENCE IS SHOWN TOO. This is the
         * one fact that makes the screen safe to act on: an application is only
         * as trustworthy as where it sends the code. `redirectDomain` is null
         * when the URI is not registered to the application, or points at an IP
         * or localhost — so a missing domain is exactly when somebody should be
         * told, rather than when the line should quietly disappear.
         */}
        <FieldDescription>
          {data.redirectDomain ? (
            <>
              You will be returned to{" "}
              <span className="text-foreground font-medium">{data.redirectDomain}</span>
              .
            </>
          ) : (
            "We could not confirm where this will send you. Only continue if you trust this application."
          )}
        </FieldDescription>

        <div className="grid grid-cols-2 gap-3">
          <Button type="submit" name="consented" value="false" variant="outline">
            Deny
          </Button>
          <Button type="submit" name="consented" value="true">
            Allow
          </Button>
        </div>
      </FieldGroup>

      {forwarded.map(([name, value]) => (
        <input key={`${name}:${value}`} type="hidden" name={name} value={value} />
      ))}
      {includeOrganization && orgId ? (
        <input type="hidden" name="organization_id" value={orgId} />
      ) : null}
    </form>
  )
}

/** The shape every non-consent state renders in, so they read as one page. */
function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <FieldGroup>
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold text-balance">{title}</h1>
        <div className="text-muted-foreground flex flex-col gap-2 text-sm text-balance">
          {children}
        </div>
      </div>
    </FieldGroup>
  )
}
