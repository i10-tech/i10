import Link from "next/link"
import { Alert } from "@repo/ui/components/alert/alert"
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
    <span role="list" className="mt-1.5 block space-y-0.5">
      {rows.slice(0, 3).map((e) => (
        <span role="listitem" key={e.id} className="block">
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
        </span>
      ))}
      {rows.length > 3 && (
        <span role="listitem" className="block text-xs text-muted-foreground">
          and {rows.length - 3} more
        </span>
      )}
    </span>
  )

  if (disabled.length > 0) {
    return (
      <Alert
        tone="danger"
        title={
          disabled.length === 1
            ? "i10 switched off an endpoint"
            : `i10 switched off ${disabled.length} endpoints`
        }
      >
        <span className="block not-first:mt-1.5">
          Nothing is sent to {disabled.length === 1 ? "it" : "them"} until you turn{" "}
          {disabled.length === 1 ? "it" : "them"} back on. Fix the receiver, turn it on,
          then recover what failed from its Replays tab.
        </span>
        {list(disabled)}
        {failing.length > 0 && (
          <span className="block not-first:mt-1.5">
            {failing.length === 1
              ? "Another endpoint is failing."
              : `${failing.length} more are failing.`}
          </span>
        )}
      </Alert>
    )
  }

  return (
    <Alert
      tone="warning"
      title={
        failing.length === 1
          ? "An endpoint is failing"
          : `${failing.length} endpoints are failing`
      }
    >
      <span className="block not-first:mt-1.5">
        Nothing has been delivered for at least 15 minutes. We keep retrying, and switch
        an endpoint off if it goes days without a success.
      </span>
      {list(failing)}
    </Alert>
  )
}
