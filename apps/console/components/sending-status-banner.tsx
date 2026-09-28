import Link from "next/link"
import { AlertTriangle, ShieldCheck } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert"
import { findingReason } from "@/components/sending-health"
import { tryApi } from "@/lib/api"
import type { SendingStatus } from "@/lib/types"

/**
 * What our email provider has done to this workspace's sending (#157).
 *
 * ⚠ ON EVERY PAGE WHILE IT IS TRUE, NOT ON ONE STATUS PAGE. A paused workspace
 * finds out because its API calls start failing with `sending_paused`; whoever
 * opens the console next should be told why before they go hunting through
 * logs, whichever page they land on.
 *
 * ⚠ NOTHING RENDERS WHEN THE CALL FAILS. The banner is advisory: a slow or
 * broken status read must never paint a pause that did not happen, and must
 * never take the page down with it.
 *
 * ⚠ AN OPEN REPUTATION FINDING IS AMBER, NOT RED (#158). Nothing has stopped;
 * it is the warning before the pause, and the one moment the customer can
 * still prevent it. The green "Healthy" lives in the sidebar and the overview,
 * not here - a banner on every page for good news is a banner people learn to
 * ignore before the bad news arrives.
 *
 * ⚠ `reinstated` GETS ITS OWN, QUIETER NOTE. Sending works again, but the
 * workspace is on probation - new bounces weigh more until the old findings
 * clear - and that is worth one line, not an alarm.
 */
export async function SendingStatusBanner() {
  const result = await tryApi<SendingStatus>("/console/sending-status")
  if (!result.ok) return null
  const { status, cause, health, findings } = result.data
  if (status === "enabled" && health === "healthy") return null

  if (status === "enabled" && health === "at_risk") {
    const worst = findings[0]
    return (
      <div className="border-b px-4 py-3 sm:px-6">
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>Sending is at risk of being paused</AlertTitle>
          <AlertDescription>
            <p>
              {worst
                ? findingReason(worst.type)
                : "Our email provider flagged recent mail."}{" "}
              Sending still works, but our email provider pauses it automatically if
              this continues.
            </p>
            {worst?.description ? <p>What it found: {worst.description}</p> : null}
            <p>
              Look at{" "}
              <Link
                href="/emails?status=bounced"
                className="underline underline-offset-4"
              >
                recent bounces
              </Link>{" "}
              and complaints, and stop sending to addresses that did not ask for your
              mail. The{" "}
              <Link href="/" className="underline underline-offset-4">
                overview
              </Link>{" "}
              shows your rates.
            </p>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  if (status === "reinstated") {
    return (
      <div className="border-b px-4 py-3 sm:px-6">
        <Alert>
          <ShieldCheck />
          <AlertTitle>Sending has resumed</AlertTitle>
          <AlertDescription>
            <p>
              For a while, new bounces and complaints count against this workspace more
              heavily. Keep an eye on the{" "}
              <Link href="/suppressions" className="underline underline-offset-4">
                suppression list
              </Link>
              .
            </p>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="border-b px-4 py-3 sm:px-6">
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Sending is paused for this workspace</AlertTitle>
        <AlertDescription>
          <p>
            Our email provider paused sending, usually because too many recent messages
            bounced or were marked as spam. Until it is lifted, the API refuses new
            emails with a <code className="font-mono text-xs">sending_paused</code>{" "}
            error. Mailboxes and domains keep working.
          </p>
          {cause ? <p>The reason given: {cause}</p> : null}
          <p>
            Review your{" "}
            <Link href="/suppressions" className="underline underline-offset-4">
              suppressions
            </Link>{" "}
            and{" "}
            <Link
              href="/emails?status=bounced"
              className="underline underline-offset-4"
            >
              recent bounces
            </Link>
            , stop sending to addresses that did not ask for your mail, then reply to
            the email we sent the workspace owner and we will review it with you.
          </p>
        </AlertDescription>
      </Alert>
    </div>
  )
}
