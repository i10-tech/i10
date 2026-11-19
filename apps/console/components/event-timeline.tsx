"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { StatusDot, describeStatus } from "@/components/status"
import { JsonViewer } from "@repo/ui/components/json-viewer/json-viewer"
import { cn } from "cn"
import { Time } from "@/components/time"

interface Step {
  type: string
  /*
   * ⚠ A NODE RATHER THAN A STRING, SO THAT A TIMESTAMP INSIDE A LABEL CAN GO
   * THROUGH `<Time>`. The scheduled step used to interpolate `formatExact`
   * here, which formats in the RUNTIME'S TIME ZONE - UTC in the server
   * container, something else in the reader's browser. This is a client
   * component, so both passes run and disagree by hours, and React answers a
   * hydration mismatch by throwing away the server HTML for the subtree and
   * re-rendering it. See components/time.tsx.
   */
  label: React.ReactNode
  occurred_at: string
  payload: unknown
  synthetic: boolean
}

/**
 * What happened to one message, in order.
 *
 * ⚠ ORDERED BY TIME HERE, UNLIKE THE STATUS BADGE, AND THE TWO ARE ANSWERING
 * DIFFERENT QUESTIONS. The badge shows the WORST outcome by severity, because
 * "did this work" has one answer and it must not depend on which mail server
 * replied faster. This list shows the sequence, because "what happened" is a
 * story - accepted, delivered to one recipient, bounced from another.
 *
 * ⚠ AND A MESSAGE WITH SEVERAL RECIPIENTS PRODUCES SEVERAL EVENTS OF THE SAME
 * TYPE. They are not deduplicated: two `delivered` events mean two recipients
 * received it, and collapsing them would hide the fact that the third did not.
 *
 * ⚠ THE PAYLOAD IS EXPANDABLE AND RENDERED AS TEXT. It is the provider's raw
 * notification - SES's bounce object, Stalwart's delivery report - and it is
 * where the diagnostic code lives. It is also third-party JSON, so it goes
 * through `JSON.stringify` into a `<pre>` and never near `innerHTML`.
 */
export function EventTimeline({
  events = [],
  createdAt = "",
  scheduledAt = null,
  stepsCount = 3,
  loading = false,
}: {
  events?: { type: string; occurred_at: string; payload: unknown }[]
  createdAt?: string
  scheduledAt?: string | null
  stepsCount?: number
  loading?: boolean
}) {
  const [open, setOpen] = React.useState<number | null>(null)

  /*
   * ⚠ THE ACCEPTED STEP IS SYNTHESISED FROM `created_at`, BECAUSE NOTHING EMITS
   * IT. Every event in `core.message_events` originates at the provider - SES
   * publishes `Send` when it accepts, and everything after that follows. The
   * moment WE accepted the API call is the row's own timestamp, and without it
   * the timeline for a queued message is completely empty, which reads as the
   * request having been lost.
   */
  const steps: Step[] = [
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
    ...foldEngagement(events).map((event) => ({
      type: event.type,
      label:
        event.count > 1
          ? `${describeStatus(event.type).label} ${event.count} times`
          : describeStatus(event.type).label,
      occurred_at: event.occurred_at,
      payload: event.payload,
      synthetic: false,
    })),
  ]

  // ⚠ ONE LIST FOR THE PAGE AND ITS SKELETON. Loading draws `stepsCount` rows with
  // a bar for each piece; the rows past the first need `payload` to know whether
  // they open, which is data, so the chevron is skipped.
  const rows: (Step | undefined)[] = loading
    ? Array.from({ length: Math.max(1, stepsCount) }, () => undefined)
    : steps

  return (
    <ol className="space-y-0">
      {rows.map((step, index) => {
        const described = step ? describeStatus(step.type) : null
        const last = index === rows.length - 1
        const expandable = step
          ? step.payload !== null && step.payload !== undefined
          : false

        return (
          <BoneScope
            key={step ? `${step.type}-${step.occurred_at}-${index}` : index}
            id={`row-${index}`}
            unit
          >
            <li className="relative">
              {
                /*
                 * ⚠ THE CONNECTOR IS AN ABSOLUTELY POSITIONED RULE, NOT A BORDER ON
                 * THE LIST ITEM. A left border would run the full height of the
                 * last item too, leaving a line dangling below the final dot - the
                 * detail that makes a hand-built timeline look unfinished.
                 */
                !last && (
                  <span
                    aria-hidden="true"
                    className="absolute top-4 bottom-0 left-[3px] w-px bg-border"
                  />
                )
              }

              <div className="flex gap-3 pb-4 last:pb-0">
                <Bone
                  id="dot"
                  shape="box"
                  width={8}
                  height={8}
                  radius={9999}
                  inline
                  className="mt-1.5 shrink-0"
                >
                  {described && <StatusDot tone={described.tone} />}
                </Bone>

                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    disabled={!expandable}
                    data-expandable={expandable || undefined}
                    onClick={() => setOpen(open === index ? null : index)}
                    className="flex w-full items-start gap-1 text-left data-[expandable]:cursor-pointer"
                  >
                    <span className="min-w-0 flex-1">
                      <Bone
                        id="label"
                        lineHeight={16}
                        width={index % 2 === 0 ? "70%" : "50%"}
                      >
                        {step && (
                          <span className="block text-sm leading-tight">
                            {step.label}
                          </span>
                        )}
                      </Bone>
                      <Bone id="time" lineHeight={14} width={80}>
                        {step && (
                          <Time
                            iso={step.occurred_at}
                            className="block text-xs text-muted-foreground"
                          />
                        )}
                      </Bone>
                    </span>
                    {/* ⚠ SKIPPED BY test/skeleton-parity: only events that carry a payload open, and a skeleton has none. */}
                    {expandable && (
                      <ChevronRight
                        data-skeleton="skip"
                        className={cn(
                          "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
                          "duration-(--duration-instant) ease-(--ease-linear)",
                          open === index && "rotate-90",
                        )}
                      />
                    )}
                  </button>

                  {step && open === index && expandable && (
                    <JsonViewer
                      data={step.payload}
                      label={`${step.label ?? "Event"} payload`}
                      rootName="payload"
                      maxHeight={256}
                      searchable={false}
                      className="mt-2"
                    />
                  )}
                </div>
              </div>
            </li>
          </BoneScope>
        )
      })}
    </ol>
  )
}

/**
 * Opens and clicks, one row per kind, at the first time it happened.
 *
 * ⚠ SES PUBLISHES AN OPEN FOR EVERY LOAD OF THE PIXEL - the recipient opening
 * it twice, Gmail's image proxy, Apple Mail's privacy prefetch - so three opens
 * on one email is normal and each is a real notification. Listing them as
 * three identical rows reads as a duplication bug; one row that says "3 times"
 * says what happened. The raw notifications are all kept, in the row's payload.
 *
 * ⚠ ONLY ENGAGEMENT IS FOLDED. Two `delivered` events mean two recipients got
 * it, and that difference must stay visible.
 */
const FOLDED = new Set(["opened", "clicked"])
function foldEngagement(
  events: { type: string; occurred_at: string; payload: unknown }[],
) {
  const out: { type: string; occurred_at: string; payload: unknown; count: number }[] =
    []
  const first = new Map<string, (typeof out)[number]>()
  for (const event of events) {
    const seen = FOLDED.has(event.type) ? first.get(event.type) : undefined
    if (seen) {
      seen.count += 1
      seen.payload = [...(seen.payload as unknown[]), event.payload]
      continue
    }
    const row = {
      ...event,
      count: 1,
      payload: FOLDED.has(event.type) ? [event.payload] : event.payload,
    }
    if (FOLDED.has(event.type)) first.set(event.type, row)
    out.push(row)
  }
  // A single open shows its notification as itself, not as a list of one.
  return out.map((row) =>
    row.count === 1 && FOLDED.has(row.type)
      ? { ...row, payload: (row.payload as unknown[])[0] }
      : row,
  )
}
