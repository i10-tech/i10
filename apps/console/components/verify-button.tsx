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
 */
export function VerifyButton({ id, status }: { id: string; status: string }) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)

  async function run() {
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
  }

  return (
    <Button
      variant={status === "verified" ? "outline" : "default"}
      size="sm"
      onClick={run}
      disabled={pending}
    >
      {pending ? <Spinner /> : <RefreshCw />}
      {status === "verified" ? "Re-check" : "Verify"}
    </Button>
  )
}
