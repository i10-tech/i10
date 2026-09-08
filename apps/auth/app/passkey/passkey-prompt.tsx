"use client"

import { useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { Field, FieldDescription, FieldGroup } from "@repo/ui/components/field"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"

/*
 * Signing in with a passkey.
 *
 * ⚠ THIS PROVES A PASSKEY, IT DOES NOT CREATE ONE. Registering one is an
 * account-settings action that requires an existing session — a signed-in
 * person adding a credential — and it belongs wherever the console grows a
 * security page. This is the other half: somebody who is signed OUT proving
 * they hold one. Putting both behind one button is how you end up silently
 * enrolling a passkey on a device that just borrowed the laptop.
 *
 * ⚠ AND IT IS ITS OWN PAGE RATHER THAN A BUTTON ON THE SIGN-IN FORM. The
 * browser's passkey sheet is a native, modal, one-shot prompt: it steals focus,
 * it cannot be re-opened without a fresh user gesture, and a person who
 * dismisses it needs somewhere obvious to press again. A page gives it that.
 */
export function PasskeyPrompt({
  afterAuthUrl,
  signInHref,
}: {
  afterAuthUrl: string
  signInHref: string
}) {
  const { signIn } = useSignIn()
  const [pending, setPending] = useState(false)

  async function prove() {
    if (!signIn || pending) return
    setPending(true)

    try {
      // ⚠ `discoverable`, NOT `autofill`. Autofill is the other flow — the
      // browser quietly offering a passkey inside a username box the moment the
      // page loads, which needs an input to attach to and must be armed before
      // the person interacts. This page has no username field and exists
      // precisely because somebody pressed a button, so the prompt must be the
      // one that opens on demand.
      const { error } = await signIn.passkey({ flow: "discoverable" })

      if (error) {
        toast.error(messageFor(error))
        return
      }

      if (signIn.status === "complete") {
        // Cross-origin, and `decorateUrl` carries Safari's cookie refresh —
        // see the sign-in form.
        await signIn.finalize({
          navigate: ({ decorateUrl }) => {
            window.location.href = decorateUrl(afterAuthUrl)
          },
        })
        return
      }

      toast.error("That passkey worked, but the sign-in needs another step.")
    } catch {
      // ⚠ THE CATCH IS LOAD-BEARING HERE, unlike on the password forms. A
      // passkey prompt is WebAuthn: dismissing the sheet, or a browser with no
      // authenticator, rejects at the platform level rather than coming back as
      // a Clerk error — and an unhandled rejection would leave the button stuck
      // on "Waiting…" forever.
      toast.error(TRANSPORT_FAILURE)
    } finally {
      setPending(false)
    }
  }

  return (
    <FieldGroup>
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-2xl font-bold">Use your passkey</h1>
        <p className="text-sm text-balance text-muted-foreground">
          Your device will ask for your fingerprint, face or screen lock. Nothing is
          typed and nothing is sent to us — the passkey never leaves your device.
        </p>
      </div>

      <Field>
        <Button type="button" onClick={prove} disabled={!signIn || pending}>
          {pending ? "Waiting for your device…" : "Continue with passkey"}
        </Button>
      </Field>

      <FieldDescription className="text-center">
        Don&apos;t have one set up?{" "}
        <Link href={signInHref} className="underline underline-offset-4">
          Sign in with your password
        </Link>
      </FieldDescription>
    </FieldGroup>
  )
}
