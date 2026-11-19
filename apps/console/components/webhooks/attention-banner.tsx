import Link from "next/link"
import { Alert } from "@repo/ui/components/alert/alert"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { Time } from "@/components/time"
import { shortName } from "@/lib/webhooks"
import type { WebhookBannerState } from "@/lib/shapes/webhooks"
import type { WebhookEndpoint } from "@/lib/types"

/**
 * Endpoints that need someone, above the list (#286).
 *
 * ⚠ DISABLED OUTRANKS FAILING. A failing endpoint is still being retried and
 * may recover by itself; a disabled one receives nothing until a person turns
 * it back on, and every event in between waits.
 *
 * ⚠ A CUSTOMER'S OWN PAUSE IS NOT HERE. They did it on purpose; a banner about
 * it would be the console arguing with a decision.
 *
 * ⚠ ONE RENDER FOR THE PAGE AND ITS SKELETON. Which banner shows is the shape's;
 * how many endpoints it names is data, so the names are one Bone and the copy
 * is the singular while loading.
 */
export function WebhookAttentionBanner({
  endpoints,
  banner: bannerProp,
}: {
  endpoints?: WebhookEndpoint[]
  banner?: WebhookBannerState
}) {
  const loading = endpoints === undefined
  const disabled = (endpoints ?? []).filter((e) => e.health === "disabled")
  const failing = (endpoints ?? []).filter((e) => e.health === "failing" && e.enabled)

  const activeBanner: WebhookBannerState = loading
    ? (bannerProp ?? "none")
    : disabled.length > 0 && failing.length > 0
      ? "both"
      : disabled.length > 0
        ? "disabled"
        : failing.length > 0
          ? "failing"
          : "none"

  if (activeBanner === "none") return null

  const names = (id: string, rows: WebhookEndpoint[], sentence: boolean) => (
    <span role="list" className="mt-1.5 block space-y-1.5">
      {/* ⚠ 18, NOT 16: the alert's text line is 18px, so a row is. */}
      <Bone id={id} width={160} lineHeight={18} lines={sentence ? 2 : 1}>
        {rows.slice(0, 3).map((e) => (
          <span role="listitem" key={e.id} className="block">
            <Link
              href={`/webhooks/${e.id}`}
              className="font-mono text-xs underline-offset-4 hover:underline"
            >
              {shortName(e)}
            </Link>
            {sentence && (
              <span className="block text-xs text-muted-foreground">
                <SwitchedOff endpoint={e} />
              </span>
            )}
          </span>
        ))}
        {rows.length > 3 && (
          <span role="listitem" className="block text-xs text-muted-foreground">
            and {rows.length - 3} more
          </span>
        )}
      </Bone>
    </span>
  )

  if (activeBanner === "disabled" || activeBanner === "both") {
    const one = loading || disabled.length === 1
    return (
      <BoneScope id="attention-banner" loading={loading}>
        <Alert
          tone="danger"
          iconAlign="center"
          title={
            one
              ? "We switched off an endpoint"
              : `We switched off ${disabled.length} endpoints`
          }
        >
          {names("banner-disabled-name", disabled, true)}
          <span className="block not-first:mt-1.5">
            Nothing is sent to {one ? "it" : "them"} until you turn{" "}
            {one ? "it" : "them"} back on. Fix the receiver, turn it on, then recover
            what failed from its Replays tab.
          </span>
          {activeBanner === "both" && (
            <span className="block not-first:mt-1.5">
              {loading || failing.length === 1
                ? "Another endpoint is failing. We will switch it off too if it keeps failing."
                : `${failing.length} more are failing. We will switch them off too if they keep failing.`}
            </span>
          )}
        </Alert>
      </BoneScope>
    )
  }

  return (
    <BoneScope id="attention-banner" loading={loading}>
      <Alert
        tone="warning"
        iconAlign="center"
        title={
          loading || failing.length === 1
            ? "An endpoint is failing"
            : `${failing.length} endpoints are failing`
        }
      >
        <span className="block not-first:mt-1.5">
          Nothing has been delivered for at least 15 minutes. We keep retrying, and we
          switch an endpoint off if it goes days without a success.
        </span>
        {names("banner-failing-name", failing, false)}
      </Alert>
    </BoneScope>
  )
}

const DAYS_WITHOUT_SUCCESS = /^No successful delivery for (\d+) days?\.$/

/** "Switched off 5 days ago after 3 days without a successful delivery." */
function SwitchedOff({ endpoint }: { endpoint: WebhookEndpoint }) {
  const { health_changed_at: at, disabled_reason: reason } = endpoint
  const days = reason ? DAYS_WITHOUT_SUCCESS.exec(reason)?.[1] : undefined
  const when = at ? (
    <>
      {" "}
      <Time iso={at} />
    </>
  ) : null
  if (days !== undefined) {
    return (
      <>
        Switched off{when} after {days} {days === "1" ? "day" : "days"} without a
        successful delivery.
      </>
    )
  }
  return (
    <>
      Switched off{when}.{reason ? ` ${reason}` : ""}
    </>
  )
}
