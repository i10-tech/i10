"use client"

import { useClerk } from "@clerk/nextjs"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { Button } from "@repo/ui/components/button/button"
import { useMounted } from "@/lib/react"

/**
 * The screen a refused session sees instead of the console (#340): the API
 * answered 403 `passkey_required` or `sso_required`.
 *
 * ⚠ IT REPLACES THE WHOLE SHELL. Nothing here links onward, so nothing else is
 * reachable until the person does what is asked - and the API refuses every
 * other call from this session anyway; this only says why, once.
 *
 * - `passkey_required`: the workspace requires SSO, and owners and admins who
 *   skip it must hold a passkey (decision 7). Adding one is Clerk's frontend
 *   API, so it happens in apps/auth.
 * - `sso_required`: a managed account, or one the workspace requires SSO of,
 *   on a session that did not come through the company's provider.
 */
export function AccessGate({
  kind,
  authOrigin,
  startUrl,
  clerkEnabled,
}: {
  kind: "passkey" | "sso"
  authOrigin: string | null
  /** The API's start URL for `sso_required`; it names apps/auth and is checked below. */
  startUrl: string | null
  clerkEnabled: boolean
}) {
  // ⚠ THIS PAGE'S OWN ADDRESS, KNOWN ONLY IN THE BROWSER: the links wait for it.
  const mounted = useMounted()
  const here = mounted ? window.location.href : null

  const back = here ? `?${new URLSearchParams({ redirect_url: here })}` : ""
  const passkeyHref = authOrigin ? `${authOrigin}/add-passkey${back}` : null
  // ⚠ ONLY A START URL ON apps/auth'S OWN ORIGIN IS FOLLOWED: this URL arrives in an API answer.
  const ssoHref =
    startUrl && authOrigin && safeStart(startUrl, authOrigin) && here
      ? `${startUrl}${startUrl.includes("?") ? "&" : "?"}${new URLSearchParams({ redirect_url: here })}`
      : null

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-sm flex-col gap-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-medium">
            {kind === "passkey"
              ? "Add a passkey to continue"
              : "Continue with your company"}
          </h1>
          <p className="text-sm text-balance text-muted-foreground">
            {kind === "passkey"
              ? "Your workspace requires SSO. Owners and admins who sign in another way need a passkey on their account. Add one, then come back."
              : "Your workspace signs people in through your company's identity provider. Continue there to open the console."}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {kind === "passkey" && passkeyHref && (
            <ButtonLink href={passkeyHref} native size="lg">
              Add a passkey
            </ButtonLink>
          )}
          {kind === "sso" && ssoHref && (
            <ButtonLink href={ssoHref} native size="lg">
              Continue with SSO
            </ButtonLink>
          )}
          {clerkEnabled && (
            <SignOut redirectTo={authOrigin ? `${authOrigin}/sign-in` : "/"} />
          )}
        </div>
      </div>
    </main>
  )
}

/** A start URL is followed only when it is on apps/auth's origin and is its SSO start route. */
function safeStart(startUrl: string, authOrigin: string): boolean {
  try {
    const url = new URL(startUrl)
    return url.origin === authOrigin && url.pathname === "/sso/start"
  } catch {
    return false
  }
}

function SignOut({ redirectTo }: { redirectTo: string }) {
  const { signOut } = useClerk()
  return (
    <Button
      variant="ghost"
      size="lg"
      onClick={() => void signOut({ redirectUrl: redirectTo })}
    >
      Sign out
    </Button>
  )
}
