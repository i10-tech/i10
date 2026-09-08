"use client"

import { useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { useSignIn } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button"
import { Field, FieldDescription, FieldGroup } from "@repo/ui/components/field"
import { messageFor, TRANSPORT_FAILURE } from "../_lib/errors"
import { NEUTRAL_ENVIRONMENT, passkeyEnvironment } from "../_lib/platform"

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
    <>
      {pending ? <PasskeyCue /> : null}
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
    </>
  )
}

/**
 * A hint behind the operating system's passkey dialog.
 *
 * ⚠ IT CANNOT KNOW WHERE THAT DIALOG ACTUALLY IS, AND IT DOES NOT PRETEND TO.
 * The WebAuthn prompt is drawn by the browser or the OS, outside the page and
 * outside anything script can measure — macOS Safari puts it under the toolbar,
 * Chrome centres its own sheet, Windows throws a full system modal, and a phone
 * slides one up from the bottom. So the dashed frame below is CENTRED AND
 * GENEROUS: a place to look, not a border traced around a real window. Anything
 * that claimed to be exact would be wrong on most machines and would look
 * broken rather than helpful.
 *
 * ⚠ AND IT IS `pointer-events-none`. The real dialog is modal and sits above
 * this; an overlay that swallowed clicks would do nothing for the person except
 * eat the first click after they cancel.
 */
function PasskeyCue() {
  /**
   * ⚠ `useSyncExternalStore`, NOT AN EFFECT THAT SETS STATE. `passkeyEnvironment`
   * reads `navigator`, which does not exist on the server — calling it during
   * render would produce markup disagreeing with the client and get thrown away
   * as a hydration mismatch. This hook exists for exactly this shape: a server
   * snapshot, a client snapshot, and React reconciling the two itself. The
   * subscribe function is a no-op because a platform does not change mid-visit.
   */
  const env = useSyncExternalStore(
    () => () => {},
    passkeyEnvironment,
    () => NEUTRAL_ENVIRONMENT,
  )

  const align =
    env.placement === "top"
      ? "justify-start pt-16"
      : env.placement === "bottom"
        ? "justify-end pb-16"
        : "justify-center"

  return (
    <div
      // ⚠ NOT `aria-hidden` ON THE WHOLE THING, AND NOT `role="dialog"` EITHER.
      // Hiding it all would hide the one sentence this exists to say; claiming
      // to be a dialog would fight the real one, which belongs to the OS and
      // already owns focus. The message is a polite live region and only the
      // dashed frame is hidden, because a rectangle read aloud is noise.
      //
      // ⚠ AND IT IS `pointer-events-none`. The real dialog is modal and sits
      // above this; an overlay that swallowed clicks would only eat the first
      // click after somebody cancels.
      className={`bg-background/80 pointer-events-none fixed inset-0 z-50 flex flex-col items-center gap-6 px-6 backdrop-blur-sm ${align}`}
    >
      <p role="status" className="text-center text-sm font-medium">
        Authenticate your passkey below
      </p>
      <div
        aria-hidden="true"
        className="border-muted-foreground/40 flex h-52 w-full max-w-sm items-center justify-center rounded-xl border-2 border-dashed"
      >
        <p className="text-muted-foreground px-6 text-center text-xs text-balance">
          {env.hint}
        </p>
      </div>
    </div>
  )
}
