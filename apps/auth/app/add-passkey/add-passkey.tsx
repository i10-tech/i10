"use client"

import { useEffect, useState } from "react"
import { useUser } from "@clerk/nextjs"
import { Button } from "@repo/ui/components/button/button"
import { toast } from "@repo/ui/components/i10/toasts"
import { StepHeading } from "../_components/step-heading"
import { passkeyFailure, passkeyReference } from "../_lib/passkey"
import { ReverifyCancelled, useReverify } from "../_lib/reverify"
import { abortPendingWebAuthn } from "../_lib/webauthn"

/**
 * Adds a passkey to the signed-in account, then goes back to where the person
 * came from. The same Clerk call, reverification and failure wording as the
 * sign-up flow's passkey step; see sign-up/secure-steps.tsx for why each is
 * the way it is.
 *
 * ⚠ SIGNED OUT, THERE IS NOTHING TO ADD A PASSKEY TO: the person is sent to
 * sign in, and comes back here.
 */
export function AddPasskey({ afterUrl }: { afterUrl: string }) {
  const { isLoaded, user } = useUser()
  const reverify = useReverify()
  const [busy, setBusy] = useState(false)

  async function add() {
    if (!user || busy) return
    setBusy(true)
    abortPendingWebAuthn()
    try {
      await reverify(async () => user.createPasskey())
      toast.success("Passkey added.")
      window.location.assign(afterUrl)
    } catch (error) {
      if (!(error instanceof ReverifyCancelled)) {
        const reason = passkeyFailure(error, "add")
        if (reason) toast.error(reason, { description: passkeyReference(error) })
      }
      setBusy(false)
    }
  }

  const signedOut = isLoaded && !user
  useEffect(() => {
    if (signedOut)
      window.location.replace(
        `/sign-in?redirect_url=${encodeURIComponent(window.location.href)}`,
      )
  }, [signedOut])
  if (signedOut) return null

  return (
    <div className="flex flex-col gap-6">
      <StepHeading title="Add a passkey">
        Your workspace requires single sign-on. To keep signing in another way you need
        a passkey: your fingerprint, face or screen lock, which stays on this device.
      </StepHeading>
      <Button size="lg" loading={busy} disabled={!isLoaded || !user} onClick={add}>
        Add a passkey
      </Button>
    </div>
  )
}
