import Link from "next/link"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { Alert } from "@repo/ui/components/alert/alert"
import { findingReason } from "@/components/sending-health"
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
export function SendingStatusBanner({
  status: statusProp,
  loading = false,
}: {
  status?: SendingStatus | null
  loading?: boolean
} = {}) {
  if (loading) {
    return (
      <BoneScope id="sending-status-banner" loading={true}>
        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-start gap-3">
            <Bone id="icon" shape="box" width={20} height={20} radius={4} inline />
            <div className="min-w-0 flex-1 space-y-2">
              <Bone id="title" lineHeight={20} width={240} />
              {/* Three 20px lines and the gaps between the alert's blocks:
                  the banner's measured height, so nothing below it moves. */}
              <Bone id="body" lines={3} lineHeight={21} width="90%" />
            </div>
          </div>
        </div>
      </BoneScope>
    )
  }

  const alert = statusProp ? bannerFor(statusProp) : null
  if (!alert) return null
  /*
   * ⚠ THE LOADED BANNER IS THE SKELETON'S `body` BONE (2026-11-09). Its bars
   * used to fade over text that was already there; claimed, they stretch into
   * the banner while it sharpens in, like every other block on the page.
   */
  return (
    <BoneScope id="sending-status-banner" loading={false}>
      <Bone id="body" as="div" lines={2}>
        {alert}
      </Bone>
    </BoneScope>
  )
}

function bannerFor(statusProp: SendingStatus): React.ReactNode {
  const { status, cause, health, findings, hold } = statusProp
  if (status === "enabled" && health === "healthy") return null

  if (health === "held" && hold) {
    return (
      <div>
        <Alert tone="danger" title="Sending is on hold while we review this workspace">
          <span className="block not-first:mt-1.5">
            Our automated review held sending because {hold.why}. Until it is lifted,
            the API refuses new emails with a{" "}
            <code className="font-mono text-xs">sending_held</code> error. Mailboxes,
            domains and the rest of the console keep working.
          </span>
          {hold.canceled_messages > 0 ? (
            <span className="block not-first:mt-1.5">
              {hold.canceled_messages === 1
                ? "One queued or scheduled email was"
                : `${hold.canceled_messages} queued or scheduled emails were`}{" "}
              canceled so they would not go out during the review.
            </span>
          ) : null}
          <span className="block not-first:mt-1.5">
            A person on our team reviews every hold within a day. Reply to the email we
            sent the workspace owner to tell us what you send and to whom, or if you
            think this is a mistake.
          </span>
        </Alert>
      </div>
    )
  }

  if (status === "enabled" && health === "at_risk") {
    const worst = findings[0]
    return (
      <div>
        <Alert tone="warning" title="Sending is at risk of being paused">
          <span className="block not-first:mt-1.5">
            {worst
              ? findingReason(worst.type)
              : "Our email provider flagged recent mail."}{" "}
            Sending still works, but our email provider pauses it automatically if this
            continues.
          </span>
          {worst?.description ? (
            <span className="block not-first:mt-1.5">
              What it found: {worst.description}
            </span>
          ) : null}
          <span className="block not-first:mt-1.5">
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
          </span>
        </Alert>
      </div>
    )
  }

  if (status === "reinstated") {
    return (
      <div>
        <Alert tone="success" title="Sending has resumed">
          <span className="block not-first:mt-1.5">
            For a while, new bounces and complaints count against this workspace more
            heavily. Keep an eye on the{" "}
            <Link href="/suppressions" className="underline underline-offset-4">
              suppression list
            </Link>
            .
          </span>
        </Alert>
      </div>
    )
  }

  return (
    <div>
      <Alert tone="danger" title="Sending is paused for this workspace">
        <span className="block not-first:mt-1.5">
          Our email provider paused sending, usually because too many recent messages
          bounced or were marked as spam. Until it is lifted, the API refuses new emails
          with a <code className="font-mono text-xs">sending_paused</code> error.
          Mailboxes and domains keep working.
        </span>
        {cause ? (
          <span className="block not-first:mt-1.5">The reason given: {cause}</span>
        ) : null}
        <span className="block not-first:mt-1.5">
          Review your{" "}
          <Link href="/suppressions" className="underline underline-offset-4">
            suppressions
          </Link>{" "}
          and{" "}
          <Link href="/emails?status=bounced" className="underline underline-offset-4">
            recent bounces
          </Link>
          , stop sending to addresses that did not ask for your mail, then reply to the
          email we sent the workspace owner and we will review it with you.
        </span>
      </Alert>
    </div>
  )
}
