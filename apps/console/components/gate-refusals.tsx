"use client"

import * as React from "react"
import { useAuth, useClerk, useOrganizationList } from "@clerk/nextjs"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Button } from "@repo/ui/components/button/button"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { sessionEndedCopy, type SessionEndReason } from "@/lib/identity-gate"
import { useMounted } from "@/lib/react"

/**
 * The screens a session sees when the workspace's session and network policies
 * refuse it (#345): the API answered 401 `session_expired`, 403
 * `ip_not_allowed` or 403 `mfa_required` to the shell's own call.
 *
 * ⚠ EACH REPLACES THE WHOLE SHELL, like components/access-gate.tsx, so nothing
 * behind it is reachable. The API refuses every other call from the session
 * regardless; these only say why, once. The one exception is `mfa_required`,
 * which keeps the person's own account page open, because that is where a
 * second factor is added.
 */

function Frame({
  title,
  children,
  body,
}: {
  title: string
  body: string
  children?: React.ReactNode
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-sm flex-col gap-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-medium">{title}</h1>
          <p className="text-sm text-balance text-muted-foreground">{body}</p>
        </div>
        <div className="flex flex-col gap-2">{children}</div>
      </div>
    </main>
  )
}

function signInUrl(authOrigin: string | null, back: string | null): string {
  if (!authOrigin) return "/"
  const query = back ? `?${new URLSearchParams({ redirect_url: back })}` : ""
  return `${authOrigin}/sign-in${query}`
}

/** Ends the Clerk session, then goes to `redirectTo`. */
function SignOut({
  redirectTo,
  children,
  primary = false,
}: {
  redirectTo: string
  children: React.ReactNode
  primary?: boolean
}) {
  const { signOut } = useClerk()
  return (
    <Button
      variant={primary ? "primary" : "ghost"}
      size="lg"
      onClick={() => void signOut({ redirectUrl: redirectTo })}
    >
      {children}
    </Button>
  )
}

/** 401 `session_expired`: say why, then sign in again. */
export function SessionEnded({
  reason,
  authOrigin,
  clerkEnabled,
}: {
  reason: SessionEndReason
  authOrigin: string | null
  clerkEnabled: boolean
}) {
  const mounted = useMounted()
  const here = mounted ? window.location.href : null
  const { title, body } = sessionEndedCopy(reason)
  const to = signInUrl(authOrigin, here)
  return (
    <Frame title={title} body={body}>
      {clerkEnabled ? (
        <SignOut redirectTo={to} primary>
          Sign in again
        </SignOut>
      ) : (
        <ButtonLink href={to} native size="lg">
          Sign in again
        </ButtonLink>
      )}
    </Frame>
  )
}

/** 403 `ip_not_allowed`. */
export function NetworkBlocked({
  authOrigin,
  clerkEnabled,
}: {
  authOrigin: string | null
  clerkEnabled: boolean
}) {
  return (
    <Frame
      title="Not available from this network"
      body="This workspace only allows access from its approved networks. Connect from one of them, or ask an owner of the workspace to add this address."
    >
      {clerkEnabled && <OtherWorkspaces />}
      {clerkEnabled && (
        <SignOut redirectTo={signInUrl(authOrigin, null)}>Sign out</SignOut>
      )}
    </Frame>
  )
}

/**
 * 403 `mfa_required`. The person's own account page stays open (it needs no
 * workspace data), so the second factor can be added there.
 */
export function MfaRequired({
  authOrigin,
  clerkEnabled,
  children,
}: {
  authOrigin: string | null
  clerkEnabled: boolean
  children: React.ReactNode
}) {
  const pathname = usePathname()
  if (pathname === "/account" || pathname.startsWith("/account/"))
    return (
      <div className="min-h-dvh">
        <p className="border-b bg-muted/50 px-6 py-3 text-center text-sm">
          This workspace requires a second factor. Add one below, then{" "}
          <Link href="/" className="underline underline-offset-2">
            go back to the workspace
          </Link>
          .
        </p>
        {children}
      </div>
    )
  return (
    <Frame
      title="Add a second factor to continue"
      body="This workspace requires a second factor for members who do not sign in through SSO. Add an authenticator app to your account, then come back. A passkey alone does not count."
    >
      <ButtonLink href="/account?tab=security" size="lg">
        Open account security
      </ButtonLink>
      {clerkEnabled && <OtherWorkspaces />}
      {clerkEnabled && (
        <SignOut redirectTo={signInUrl(authOrigin, null)}>Sign out</SignOut>
      )}
    </Frame>
  )
}

/** Other workspaces the person belongs to, so a refused one can be left. */
function OtherWorkspaces() {
  const router = useRouter()
  const { orgId } = useAuth()
  const { isLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: { pageSize: 10 },
  })
  const others = (userMemberships.data ?? []).filter((m) => m.organization.id !== orgId)
  if (!isLoaded || others.length === 0) return null
  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-xs text-muted-foreground">Leave this workspace for</p>
      {others.map((m) => (
        <Button
          key={m.id}
          variant="secondary"
          size="lg"
          className="w-full"
          onClick={() =>
            void setActive({ organization: m.organization.id }).then(() =>
              router.refresh(),
            )
          }
        >
          {m.organization.name}
        </Button>
      ))}
    </div>
  )
}
