"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import { StatusDot, describeStatus } from "@/components/status"
import { cn } from "cn"
import { Time } from "@/components/time"

/**
 * What happened to one message, in order.
 *
 * ⚠ ORDERED BY TIME HERE, UNLIKE THE STATUS BADGE, AND THE TWO ARE ANSWERING
 * DIFFERENT QUESTIONS. The badge shows the WORST outcome by severity, because
 * "did this work" has one answer and it must not depend on which mail server
 * replied faster. This list shows the sequence, because "what happened" is a
 * story — accepted, delivered to one recipient, bounced from another.
 *
 * ⚠ AND A MESSAGE WITH SEVERAL RECIPIENTS PRODUCES SEVERAL EVENTS OF THE SAME
 * TYPE. They are not deduplicated: two `delivered` events mean two recipients
 * received it, and collapsing them would hide the fact that the third did not.
 *
 * ⚠ THE PAYLOAD IS EXPANDABLE AND RENDERED AS TEXT. It is the provider's raw
 * notification — SES's bounce object, Stalwart's delivery report — and it is
 * where the diagnostic code lives. It is also third-party JSON, so it goes
 * through `JSON.stringify` into a `<pre>` and never near `innerHTML`.
 */
export function EventTimeline({
  events,
  createdAt,
  scheduledAt,
}: {
  events: { type: string; occurred_at: string; payload: unknown }[]
  createdAt: string
  scheduledAt: string | null
}) {
  const [open, setOpen] = React.useState<number | null>(null)

  /*
   * ⚠ THE ACCEPTED STEP IS SYNTHESISED FROM `created_at`, BECAUSE NOTHING EMITS
   * IT. Every event in `core.message_events` originates at the provider — SES
   * publishes `Send` when it accepts, and everything after that follows. The
   * moment WE accepted the API call is the row's own timestamp, and without it
   * the timeline for a queued message is completely empty, which reads as the
   * request having been lost.
   */
  const steps: {
    type: string
    /*
     * ⚠ A NODE RATHER THAN A STRING, SO THAT A TIMESTAMP INSIDE A LABEL CAN GO
     * THROUGH `<Time>`. The scheduled step used to interpolate `formatExact`
     * here, which formats in the RUNTIME'S TIME ZONE — UTC in the server
     * container, something else in the reader's browser. This is a client
     * component, so both passes run and disagree by hours, and React answers a
     * hydration mismatch by throwing away the server HTML for the subtree and
     * re-rendering it. See components/time.tsx.
     */
    label: React.ReactNode
    occurred_at: string
    payload: unknown
    synthetic: boolean
  }[] = [
    {
      type: "accepted",
      label: "Accepted by i10",
      occurred_at: createdAt,
      payload: null as unknown,
      synthetic: true,
    },
    ...(scheduledAt
      ? [
          {
            type: "scheduled",
            label: (
              <>
                Scheduled for <Time iso={scheduledAt} mode="exact" />
              </>
            ),
            occurred_at: scheduledAt,
            payload: null as unknown,
            synthetic: true,
          },
        ]
      : []),
    ...events.map((event) => ({
      type: event.type,
      label: describeStatus(event.type).label,
      occurred_at: event.occurred_at,
      payload: event.payload,
      synthetic: false,
    })),
  ]

  return (
    <ol className="space-y-0">
      {steps.map((step, index) => {
        const described = describeStatus(step.type)
        const last = index === steps.length - 1
        const expandable = step.payload !== null && step.payload !== undefined

        return (
          <li key={`${step.type}-${step.occurred_at}-${index}`} className="relative">
            {/*
             * ⚠ THE CONNECTOR IS AN ABSOLUTELY POSITIONED RULE, NOT A BORDER ON
             * THE LIST ITEM. A left border would run the full height of the
             * last item too, leaving a line dangling below the final dot — the
             * detail that makes a hand-built timeline look unfinished.
             */}
            {!last && (
              <span
                aria-hidden="true"
                className="absolute top-4 bottom-0 left-[3px] w-px bg-border"
              />
            )}

            <div className="flex gap-3 pb-4 last:pb-0">
              <StatusDot tone={described.tone} className="mt-1.5 shrink-0" />

              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  disabled={!expandable}
                  onClick={() => setOpen(open === index ? null : index)}
                  className={cn(
                    "flex w-full items-start gap-1 text-left",
                    expandable && "cursor-pointer",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm leading-tight">{step.label}</span>
                    <Time
                      iso={step.occurred_at}
                      className="block text-xs text-muted-foreground"
                    />
                  </span>
                  {expandable && (
                    <ChevronRight
                      className={cn(
                        "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
                        "duration-(--duration-instant) ease-(--ease-linear)",
                        open === index && "rotate-90",
                      )}
                    />
                  )}
                </button>

                {open === index && expandable && (
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap">
                    {safeStringify(step.payload)}
                  </pre>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * ⚠ GUARDED, BECAUSE THE PAYLOAD IS SOMEBODY ELSE'S JSON. `JSON.stringify`
 * throws on a circular reference and on a BigInt; either would take the whole
 * detail page down over a field nobody reads.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return "(could not display this payload)"
  }
}
