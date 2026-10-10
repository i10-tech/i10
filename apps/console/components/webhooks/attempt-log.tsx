"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { cn } from "cn"
import { ResponseCode } from "@/components/deliveries-table"
import { Time } from "@/components/time"
import { CodeBlock, HeaderList } from "@/components/webhooks/code-block"
import { formatDuration } from "@/lib/format"
import { ERROR_KIND_LABEL, TRIGGER_LABEL, prettyBody } from "@/lib/webhooks"
import type { WebhookAttempt } from "@/lib/types"

/**
 * Every attempt at one delivery, newest first, each with what we sent and
 * what came back.
 *
 * ⚠ THE NEWEST IS OPEN, because "why is it failing now" is about the last
 * answer, and the older ones are usually the same answer earlier.
 *
 * ⚠ `transform` IS CALLED OUT AS NOT THEIR RECEIVER'S FAULT: the
 * transformation threw, so nothing was sent at all, and the fix is in the
 * Transformation tab rather than in their handler.
 */
export function AttemptLog({
  attempts,
  polling = false,
}: {
  attempts: WebhookAttempt[]
  /** A polling endpoint is never sent to: its events are read with a poll. */
  polling?: boolean
}) {
  const ordered = React.useMemo(() => [...attempts].reverse(), [attempts])
  const [open, setOpen] = React.useState<string | null>(ordered[0]?.id ?? null)

  if (ordered.length === 0) {
    return (
      <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        {polling
          ? "Nothing is sent to a polling endpoint. This event is delivered once a poll passes back a cursor at or past it."
          : "No attempt yet. The first one is on its way."}
      </p>
    )
  }

  return (
    <ol className="divide-y overflow-hidden rounded-xl border">
      {ordered.map((a) => {
        const expanded = open === a.id
        const ok =
          a.error_kind === null && a.response_status !== null && a.response_status < 300
        return (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => setOpen(expanded ? null : a.id)}
              aria-expanded={expanded}
              className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-muted/40"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
                  expanded && "rotate-90",
                )}
              />
              <span className="tabular w-16 text-xs text-muted-foreground">
                Attempt {a.attempt}
              </span>
              <span className="w-12">
                {a.response_status !== null ? (
                  <ResponseCode status={a.response_status} />
                ) : (
                  <span
                    className={cn(
                      "font-mono text-xs",
                      ok ? "text-success" : "text-danger",
                    )}
                  >
                    {ok ? "OK" : "-"}
                  </span>
                )}
              </span>
              {a.error_kind && (
                <Badge
                  variant="outline"
                  className={cn(
                    "text-2xs",
                    a.error_kind === "transform" ? "text-warning" : "text-danger",
                  )}
                >
                  {ERROR_KIND_LABEL[a.error_kind]}
                </Badge>
              )}
              {a.trigger !== "scheduled" && (
                <Badge variant="secondary" className="text-2xs">
                  {TRIGGER_LABEL[a.trigger]}
                </Badge>
              )}
              {a.lane === "retry" && (
                <Badge variant="secondary" className="text-2xs">
                  Retried aside
                </Badge>
              )}
              <span className="tabular ml-auto text-xs text-muted-foreground">
                {formatDuration(a.duration_ms)} · <Time iso={a.created_at} />
              </span>
            </button>

            {expanded && (
              <div className="space-y-4 border-t bg-muted/15 px-4 py-4 animate-in fade-in-0">
                {a.error && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">
                      {a.error_kind === "transform"
                        ? "Your transformation failed, so nothing was sent"
                        : "Error"}
                    </p>
                    <pre className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 font-mono text-2xs whitespace-pre-wrap break-all">
                      {a.error}
                    </pre>
                  </div>
                )}
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="min-w-0 space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">Request</p>
                    <p className="font-mono text-2xs break-all">{a.url}</p>
                    <HeaderList headers={a.request_headers} />
                    <p className="text-2xs text-muted-foreground">
                      <span className="font-mono">webhook-signature</span> is left out.
                    </p>
                  </div>
                  <div className="min-w-0 space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                      Response
                      {a.response_status !== null && (
                        <span className="ml-1.5 font-mono">{a.response_status}</span>
                      )}
                    </p>
                    <HeaderList
                      headers={a.response_headers}
                      empty={
                        a.response_status === null
                          ? "No response: the request never got an answer."
                          : "No headers"
                      }
                    />
                    {a.response_status !== null && (
                      <CodeBlock
                        value={a.response_body ? prettyBody(a.response_body) : ""}
                        label="response body"
                        empty="Empty body"
                      />
                    )}
                  </div>
                </div>
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}
