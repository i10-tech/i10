import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert"
import { Time } from "@/components/time"
import { shortName } from "@/lib/webhooks"
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
 */
export function WebhookAttentionBanner({
  endpoints,
}: {
  endpoints: WebhookEndpoint[]
}) {
  const disabled = endpoints.filter((e) => e.health === "disabled")
  const failing = endpoints.filter((e) => e.health === "failing" && e.enabled)
  if (disabled.length === 0 && failing.length === 0) return null

  const list = (rows: WebhookEndpoint[]) => (
    <ul className="space-y-0.5">
      {rows.slice(0, 3).map((e) => (
        <li key={e.id}>
          <Link
            href={`/webhooks/${e.id}`}
            className="font-mono text-xs underline-offset-4 hover:underline"
          >
            {shortName(e)}
          </Link>
          {e.health_changed_at && (
            <span className="text-xs text-muted-foreground">
              {" "}
              since <Time iso={e.health_changed_at} />
            </span>
          )}
        </li>
      ))}
      {rows.length > 3 && (
        <li className="text-xs text-muted-foreground">and {rows.length - 3} more</li>
      )}
    </ul>
  )

  if (disabled.length > 0) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>
          {disabled.length === 1
            ? "i10 switched off an endpoint"
            : `i10 switched off ${disabled.length} endpoints`}
        </AlertTitle>
        <AlertDescription>
          <p>
            Nothing is sent to {disabled.length === 1 ? "it" : "them"} until you turn{" "}
            {disabled.length === 1 ? "it" : "them"} back on. Fix the receiver, turn it
            on, then recover what failed from its Replays tab.
          </p>
          {list(disabled)}
          {failing.length > 0 && (
            <p>
              {failing.length === 1
                ? "Another endpoint is failing."
                : `${failing.length} more are failing.`}
            </p>
          )}
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert variant="warning">
      <AlertTriangle />
      <AlertTitle>
        {failing.length === 1
          ? "An endpoint is failing"
          : `${failing.length} endpoints are failing`}
      </AlertTitle>
      <AlertDescription>
        <p>
          Nothing has been delivered for at least 15 minutes. We keep retrying, and
          switch an endpoint off if it goes days without a success.
        </p>
        {list(failing)}
      </AlertDescription>
    </Alert>
  )
}
