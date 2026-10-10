import { AlertTriangle, Pause } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert"
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
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>i10 switched this endpoint off</AlertTitle>
        <AlertDescription>
          {endpoint.disabled_reason && <p>{endpoint.disabled_reason}</p>}
          <p>
            Nothing is sent to it until you turn it back on. Fix the receiver first,
            then turn it on and recover what failed from the Replays tab.
            {endpoint.health_changed_at && (
              <>
                {" "}
                Switched off <Time iso={endpoint.health_changed_at} mode="exact" />.
              </>
            )}
          </p>
        </AlertDescription>
      </Alert>
    )
  }

  if (!endpoint.enabled) {
    return (
      <Alert>
        <Pause />
        <AlertTitle>Paused</AlertTitle>
        <AlertDescription>
          <p>
            Events are not being sent while it is paused. Resume it to pick up again;
            anything it missed can be sent from the Replays tab.
          </p>
        </AlertDescription>
      </Alert>
    )
  }

  if (endpoint.health === "failing") {
    const since = failingSince ?? endpoint.health_changed_at
    return (
      <Alert variant="warning">
        <AlertTriangle />
        <AlertTitle>This endpoint is failing</AlertTitle>
        <AlertDescription>
          <p>
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
          </p>
        </AlertDescription>
      </Alert>
    )
  }

  return null
}
