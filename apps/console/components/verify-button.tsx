"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
import { verifyDomain } from "@/lib/actions"

/**
 * "Check my records now."
 *
 * ⚠ THE BUTTON DOES NOT REPORT THE OUTCOME, AND IT USED TO. It swapped its own
 * label to "Not yet" while the toast said "Not visible yet" about the same
 * press — one event announced twice, in two wordings, a foot apart. The
 * argument for it was that the eye is on the button rather than the corner of
 * the screen; the answer is that every outcome this button has needs a SENTENCE
 * ("normal for the first few minutes, can take up to 72 hours"), and a button
 * cannot hold one. So the toast keeps the whole job and the button goes back to
 * being a button.
 *
 * ⚠ AND WITH IT WENT THE ENTRY ANIMATION. Reporting in place meant swapping
 * labels inside a springing box — `layout` on the button and a y-offset fade on
 * its content — which also ran on first paint, so the control rose into place
 * every time the page loaded. Nothing else in this console enters; a header
 * action that does reads as a glitch rather than as motion.
 *
 * ⚠ THE OUTCOMES ARE STILL REPORTED HONESTLY, WHICH IS THE PART WORTH KEEPING.
 * `pending` means the records have not propagated and `temporary_failure` means
 * the lookup itself failed — neither means the records are wrong. Saying
 * "failed" for either sends somebody to change DNS that was already correct,
 * which is the most expensive wrong answer this page can give.
 *
 * ⚠ AND IT REFRESHES THE SERVER COMPONENT RATHER THAN HOLDING THE RESULT. The
 * page renders per-record status from the server; putting the verify result in
 * client state would leave the table showing the old statuses next to a toast
 * saying it worked.
 */
export function VerifyButton({ id, status }: { id: string; status: string }) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)

  async function run() {
    if (pending) return
    setPending(true)
    const result = await verifyDomain(id)
    setPending(false)

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
        return
      }

      toast.error("Could not check the records", { description: result.error })
      return
    }

    /*
     * ⚠ WHAT *WE* SAW IN DNS COMES FIRST, AND NOT HAVING IT WAS THE BUG. Below
     * this is `status`, which is Amazon's opinion and lags DNS by minutes — so
     * every outcome that is really about DNS used to arrive here wearing
     * `pending` and got the propagation sentence. Somebody whose nameservers
     * had timed out was told their records had not propagated; so was somebody
     * whose DNS was finished and who was waiting on Amazon alone. Both then
     * waited for a condition that had already passed or would never clear.
     */
    const ownership = result.data.ownership

    if (ownership && !ownership.proven) {
      if (ownership.reason === "unreachable") {
        /*
         * ⚠ THIS IS NOT "YOUR RECORDS ARE WRONG", AND SAYING SO WOULD SEND
         * SOMEBODY TO BREAK RECORDS THAT ARE CORRECT. We never got an answer
         * out of their nameservers, so we learned nothing at all about what is
         * published — the same distinction the API keeps between `absent` and
         * `unreachable`, carried all the way to the sentence.
         */
        toast("We could not reach your nameservers", {
          description:
            "The lookup timed out, so we have not been able to read your records yet — this says nothing about whether they are right. Try again in a moment.",
          duration: 8000,
        })
      } else {
        toast("We cannot see the records yet", {
          description:
            "We asked your nameservers and the records are not there yet. If you have just added them, propagation is usually minutes. If it has been longer, check the host of each row — many providers append the domain for you.",
          duration: 8000,
        })
      }
      router.refresh()
      return
    }

    switch (result.data.status) {
      case "verified":
        toast.success("Verified", { description: "This domain can send now." })
        break
      /*
       * ⚠ THE DNS HALF IS DONE HERE, AND SAYING SO IS THE POINT. Reaching this
       * line means we read the customer's own nameservers and proved the
       * domain; the only thing left is Amazon, which checks on its own
       * schedule. The old wording — "the records have not propagated" — told
       * the one person who had finished that they had not.
       */
      case "pending":
        toast("Records found, waiting on Amazon", {
          description:
            "We can see your DNS and it is correct. Amazon re-checks on its own schedule, usually within minutes — nothing else is needed from you.",
          duration: 8000,
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
  }

  return (
    <Button
      variant={status === "verified" ? "outline" : "default"}
      size="sm"
      onClick={run}
      disabled={pending}
    >
      {pending ? <Spinner /> : <RefreshCw aria-hidden="true" />}
      {status === "verified" ? "Re-check" : "Verify"}
    </Button>
  )
}
