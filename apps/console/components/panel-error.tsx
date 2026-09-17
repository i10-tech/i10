import { AlertTriangle } from "lucide-react"
import { cn } from "cn"

/**
 * One panel failed; the rest of the page did not.
 *
 * ⚠ IT IS DELIBERATELY QUIET. A server component that throws takes its whole
 * route down to `error.tsx`, so every panel that fetches independently catches
 * its own failure and renders this instead — which means several of these can
 * be on screen at once during a partial outage. Full-width red alerts would
 * make a degraded page look like a catastrophic one.
 *
 * ⚠ AND IT SHOWS THE API'S OWN MESSAGE. Those are written for the customer —
 * "You have used your sending allowance for this period", "The plan does not
 * include another domain" — and replacing them with "Something went wrong"
 * throws away the only actionable thing on screen.
 */
export function PanelError({
  title,
  message,
  bare = false,
  className,
}: {
  title: string
  message: string
  /** Inside a container that already has a border. */
  bare?: boolean
  className?: string
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 px-4 py-6",
        !bare && "rounded-lg border border-dashed",
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs break-words text-muted-foreground">{message}</p>
      </div>
    </div>
  )
}
