import Link from "next/link"
import { cache } from "react"
import { AlertTriangle, ChevronRight, ShieldCheck } from "lucide-react"
import { cn } from "cn"
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert"
import { findingReason } from "@/components/sending-health"
import { tryApi } from "@/lib/api"
import type { SendingStatus } from "@/lib/types"

/**
 * What our email provider has done to this workspace's sending (#157).
 *
 * ⚠ IN FULL ON THE OVERVIEW, AND AS ONE LINE EVERYWHERE ELSE (2026-10-03). A
 * paused workspace finds out because its API calls start failing with
 * `sending_paused`; whoever opens the console next should be told before they
 * go hunting through logs, whichever page they land on - so `SendingStatusNotice`
 * sits in the rail on every page and leads here. It replaced a full-width band
 * above every page, which was the top bar the console no longer has.
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
 *
 * ⚠ A HOLD (#170) COMES FIRST AND READS DIFFERENTLY FROM A PAUSE. A pause is
 * our email provider's and lifts with better rates; a hold is our own review
 * and lifts when a person looks. The banner names the category, never the
 * threshold, and says how to reach that person.
 */
export async function SendingStatusBanner() {
  const result = await readStatus()
  if (!result.ok) return null
  const { status, cause, health, findings, hold } = result.data
  if (status === "enabled" && health === "healthy") return null

  if (health === "held" && hold) {
    return (
      <div>
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Sending is on hold while we review this workspace</AlertTitle>
          <AlertDescription>
            <p>
              Our automated review held sending because {hold.why}. Until it is lifted,
              the API refuses new emails with a{" "}
              <code className="font-mono text-xs">sending_held</code> error. Mailboxes,
              domains and the rest of the console keep working.
            </p>
            {hold.canceled_messages > 0 ? (
              <p>
                {hold.canceled_messages === 1
                  ? "One queued or scheduled email was"
                  : `${hold.canceled_messages} queued or scheduled emails were`}{" "}
                canceled so they would not go out during the review.
              </p>
            ) : null}
            <p>
              A person on our team reviews every hold within a day. Reply to the email
              we sent the workspace owner to tell us what you send and to whom, or if
              you think this is a mistake.
            </p>
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  if (status === "enabled" && health === "at_risk") {
    const worst = findings[0]
    return (
      <div>
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
      <div>
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
    <div>
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

/**
 * ⚠ ONE READ PER REQUEST. The rail's notice, the mobile notice and the
 * overview's banner all ask; `cache` makes that one call to the API.
 */
const readStatus = cache(() => tryApi<SendingStatus>("/console/sending-status"))

/**
 * The one-line version, for the rail: what is wrong in four words, and a way
 * to the overview where the banner says the rest.
 */
export async function SendingStatusNotice({ className }: { className?: string }) {
  const result = await readStatus()
  if (!result.ok) return null
  const { status, health, hold } = result.data
  if (status === "enabled" && health === "healthy") return null

  const notice =
    health === "held" && hold
      ? { tone: "danger", title: "Sending on hold" }
      : status === "enabled" && health === "at_risk"
        ? { tone: "warning", title: "Sending at risk" }
        : status === "reinstated"
          ? { tone: "neutral", title: "Sending resumed" }
          : { tone: "danger", title: "Sending paused" }

  return (
    <Link
      href="/"
      className={cn(
        "group flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs font-medium",
        "transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        notice.tone === "danger" &&
          "border-danger/30 bg-danger/8 text-danger hover:bg-danger/12",
        notice.tone === "warning" &&
          "border-warning/30 bg-warning/8 text-warning hover:bg-warning/12",
        notice.tone === "neutral" && "bg-muted/50 text-foreground hover:bg-muted",
        className,
      )}
    >
      {notice.tone === "neutral" ? (
        <ShieldCheck className="size-3.5 shrink-0" />
      ) : (
        <AlertTriangle className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{notice.title}</span>
      <ChevronRight className="size-3.5 shrink-0 opacity-60 transition-opacity group-hover:opacity-100" />
    </Link>
  )
}
