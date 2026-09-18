"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { ActionButton, useActionState } from "@repo/ui/components/action-button"
import { verifyDomain } from "@/lib/actions"

/**
 * "Check my records now."
 *
 * ⚠ THE OUTCOME IS REPORTED HONESTLY, INCLUDING THE BORING ONE. Verification is
 * not instant: `pending` means the records have not propagated yet and
 * `temporary_failure` means the lookup itself failed — neither means the
 * records are wrong. A button that said "Verified" or "Failed" would tell
 * somebody with correct records to go and change them, which is the most
 * expensive possible wrong answer on this page.
 *
 * ⚠ AND IT REFRESHES THE SERVER COMPONENT RATHER THAN HOLDING THE RESULT. The
 * page renders per-record status from the server; putting the verify result in
 * client state would leave the table showing the old statuses next to a toast
 * saying it worked.
 *
 * ⚠ THE BUTTON NOW CARRIES THE ONE-WORD ANSWER AND THE TOAST STILL CARRIES THE
 * REAL ONE, WHICH IS NOT REDUNDANCY. This screen is a table of DNS records and
 * the button sits at the top of it: somebody who presses Verify is looking at
 * the button, not at the corner of the window where a toast appears. A tick in
 * place is what tells them the call finished. It cannot tell them that a
 * `pending` result is normal for the first few minutes and can take 72 hours —
 * so that sentence stays exactly where it was.
 *
 * ⚠ AND `pending` AND `temporary_failure` SHOW AS "Not yet", NOT AS A CROSS.
 * Neither means the records are wrong, and a red X against correct records is
 * the most expensive wrong answer this page can give — it sends somebody to
 * change DNS that was already right.
 */
export function VerifyButton({ id, status }: { id: string; status: string }) {
  const router = useRouter()
  const { state, run: withState, reset } = useActionState()
  const [outcome, setOutcome] = React.useState<string | null>(null)

  async function run() {
    await withState(async () => {
      const result = await verifyDomain(id)

      // ⚠ CLEARED AT THE START OF EVERY RUN. Without this a `pending` result
      // leaves "Not yet" in state, and the NEXT press — which failed for an
      // entirely different reason, or never reached the API at all — reports
      // the previous run's wording as if it were this one's.
      setOutcome(null)

      if (!result.ok) {
        /*
         * ⚠ A CLAIMED NAME IS NOT A FAILED CHECK, AND MUST NOT SAY "try again".
         * It is the one refusal on this button that will never clear by itself:
         * another workspace has proved ownership, so pressing Verify for the next
         * hour changes nothing. The message names what to do instead.
         */
        if (result.name === "domain_already_claimed") {
          toast.error("This domain is spoken for", {
            description: result.error,
            duration: 10_000,
          })
          router.refresh()
          setOutcome("Claimed")
          return false
        }

        toast.error("Could not check the records", { description: result.error })
        return false
      }

      switch (result.data.status) {
        case "verified":
          toast.success("Verified", { description: "This domain can send now." })
          break
        case "pending":
          toast("Not visible yet", {
            description:
              "The records have not propagated. This is normal for the first few minutes and can take up to 72 hours.",
          })
          break
        case "temporary_failure":
          toast("Lookup failed, retrying", {
            description:
              "The DNS lookup itself failed — this does not mean your records are wrong. We will keep checking.",
          })
          break
        default:
          toast.error("Records not found", {
            description:
              "Check each row against what your DNS provider shows. A trailing dot or a quoted value is the usual cause.",
          })
      }

      router.refresh()

      // ⚠ ONLY `verified` IS A TICK. The other three are outcomes the button
      // reports as "Not yet" — see the note at the top for why a cross against a
      // `pending` lookup is worse than saying nothing.
      setOutcome(result.data.status === "verified" ? "Verified" : "Not yet")
      return result.data.status === "verified"
    })
  }

  return (
    <ActionButton
      variant={status === "verified" ? "outline" : "default"}
      size="sm"
      state={state}
      onClick={run}
      pendingLabel="Checking…"
      doneLabel={outcome ?? "Verified"}
      failedLabel={outcome ?? "Failed"}
      onReset={reset}
    >
      <RefreshCw aria-hidden="true" />
      {status === "verified" ? "Re-check" : "Verify"}
    </ActionButton>
  )
}
