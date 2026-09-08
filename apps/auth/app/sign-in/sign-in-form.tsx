"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@repo/ui/components/field"
import { Input } from "@repo/ui/components/input"
import { OAuthButtons } from "../_components/oauth-buttons"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"

/*
 * shadcn's `login-02`, wired to Clerk.
 *
 * ⚠ THE MARKUP IS THE BLOCK'S, UNCHANGED. Only three things differ, and each is
 * behaviour rather than taste: the two placeholder `<a href="#">` links now go
 * somewhere, the single hard-coded GitHub button became the three providers we
 * actually enabled, and the form submits instead of reloading the page. Nothing
 * was restyled — a block edited for taste on arrival is a block that can no
 * longer be diffed against upstream.
 */
export function SignInForm({
  afterAuthUrl,
  signUpHref,
  resetHref,
  mfaHref,
  passkeyHref,
}: {
  afterAuthUrl: string
  signUpHref: string
  resetHref: string
  mfaHref: string
  passkeyHref: string
}) {
  const router = useRouter()
  const { signIn } = useSignIn()
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // ⚠ `signIn` IS NULL UNTIL CLERK LOADS. It is the only readiness signal the
    // hook gives; there is no `isLoaded` on this API.
    if (!signIn || pending) return

    const form = new FormData(event.currentTarget)
    setPending(true)

    try {
      const { error } = await signIn.password({
        identifier: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      })

      if (error) {
        toast.error(messageFor(error))
        return
      }

      if (signIn.status === "complete") {
        // ⚠ `finalize` IS WHAT CREATES THE SESSION, and its `navigate` is how a
        // CROSS-ORIGIN destination is reached. `decorateUrl` is not optional
        // decoration: on Safari it carries the handshake that lets the cookie
        // survive ITP, and skipping it means a customer on iOS lands on the
        // dashboard signed out. Next's router cannot route to another origin,
        // so the assignment is deliberate.
        await signIn.finalize({
          navigate: ({ decorateUrl }) => {
            window.location.href = decorateUrl(afterAuthUrl)
          },
        })
        return
      }

      if (signIn.status === "needs_second_factor") {
        // ⚠ `router.push`, NEVER `window.location`. The second-factor page
        // resumes THIS `signIn` out of Clerk's client state; a full page load
        // would start a fresh client with no attempt in progress and bounce the
        // person back to the beginning, having already given their password.
        router.push(mfaHref)
        return
      }

      // ⚠ ANYTHING ELSE IS A DEAD END *TODAY*, AND IT SAYS SO RATHER THAN
      // FAILING QUIETLY. `needs_new_password` — an admin forcing a change — is
      // the notable one still unhandled. Leaving the button spinning would be
      // the worst option; naming the state at least tells support what
      // happened.
      toast.error("This sign-in needs a step we do not support yet. Contact support.")
    } catch {
      toast.error(TRANSPORT_FAILURE)
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={onSubmit} noValidate>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Login to your account</h1>
          <p className="text-sm text-balance text-muted-foreground">
            Enter your email below to login to your account
          </p>
        </div>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="m@example.com"
            autoComplete="email"
            required
          />
        </Field>
        <Field>
          <div className="flex items-center">
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Link
              href={resetHref}
              className="ml-auto text-sm underline-offset-4 hover:underline"
            >
              Forgot your password?
            </Link>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            // ⚠ `current-password`, NOT `password`. It is what tells a password
            // manager to offer the saved credential rather than to propose a
            // new one, and getting it wrong is how people end up with a second
            // entry for the same site.
            autoComplete="current-password"
            required
          />
        </Field>
        <Field>
          <Button type="submit" disabled={!signIn || pending}>
            {pending ? "Signing in…" : "Login"}
          </Button>
        </Field>
        <FieldSeparator>Or continue with</FieldSeparator>
        <OAuthButtons afterAuthUrl={afterAuthUrl} />
        <FieldDescription className="text-center">
          <Link href={passkeyHref} className="underline underline-offset-4">
            Use a passkey instead
          </Link>
        </FieldDescription>
        <FieldDescription className="text-center">
          Don&apos;t have an account?{" "}
          <Link href={signUpHref} className="underline underline-offset-4">
            Sign up
          </Link>
        </FieldDescription>
      </FieldGroup>
    </form>
  )
}
