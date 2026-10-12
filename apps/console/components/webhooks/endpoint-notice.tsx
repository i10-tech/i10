import { Alert } from "@repo/ui/components/alert/alert"
import { Time } from "@/components/time"
import type { WebhookEndpoint } from "@/lib/types"

/**
 * Why this endpoint is not receiving events, when it is not.
 *
 * ⚠ THREE CASES, THREE REMEDIES. i10 switched it off: fix the receiver, then
 * turn it back on, then recover what failed. It is failing: nothing to press,
 * the retries are running, and here is since when. You paused it: resume it.
 */
export function EndpointNotice({
  endpoint,
  failingSince,
}: {
  endpoint: WebhookEndpoint
  failingSince: string | null
}) {
  if (endpoint.health === "disabled") {
    return (
      <Alert tone="danger" title="i10 switched this endpoint off">
        {endpoint.disabled_reason && (
          <span className="block not-first:mt-1.5">{endpoint.disabled_reason}</span>
        )}
        <span className="block not-first:mt-1.5">
          Nothing is sent to it until you turn it back on. Fix the receiver first, then
          turn it on and recover what failed from the Replays tab.
          {endpoint.health_changed_at && (
            <>
              {" "}
              Switched off <Time iso={endpoint.health_changed_at} mode="exact" />.
            </>
          )}
        </span>
      </Alert>
    )
  }

  if (!endpoint.enabled) {
    return (
      <Alert tone="info" title="Paused">
        <span className="block not-first:mt-1.5">
          Events are not being sent while it is paused. Resume it to pick up again;
          anything it missed can be sent from the Replays tab.
        </span>
      </Alert>
    )
  }

  if (endpoint.health === "failing") {
    const since = failingSince ?? endpoint.health_changed_at
    return (
      <Alert tone="warning" title="This endpoint is failing">
        <span className="block not-first:mt-1.5">
          Nothing has been delivered
          {since ? (
            <>
              {" "}
              since <Time iso={since} mode="exact" />
            </>
          ) : (
            " for at least 15 minutes"
          )}
          . We keep retrying on the schedule your plan sets, and switch it off if it
          goes days without a success. The Deliveries tab shows what your receiver
          answered.
        </span>
      </Alert>
    )
  }

  return null
}
