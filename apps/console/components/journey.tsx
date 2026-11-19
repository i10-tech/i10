"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import {
  Ban,
  CalendarClock,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  CircleAlert,
  FilePen,
  Flag,
  Globe,
  Hourglass,
  ListChecks,
  LoaderCircle,
  MailMinus,
  MailOpen,
  MousePointerClick,
  Send,
  TriangleAlert,
} from "lucide-react"
import { Tooltip } from "@repo/ui/components/tooltip/tooltip"
import { cn } from "cn"
import { AutoHeight } from "@repo/ui/components/i10/auto-height"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { useExactTime } from "@/components/time"
import type { JourneyIcon, JourneyStep } from "@/lib/journey"
import { useMounted } from "@/lib/react"

const ICONS: Record<JourneyIcon, React.ComponentType<{ className?: string }>> = {
  queued: Clock,
  scheduled: CalendarClock,
  sent: Send,
  delivered: CircleCheck,
  delayed: Hourglass,
  bounced: CircleX,
  rejected: Ban,
  failed: TriangleAlert,
  complained: Flag,
  opened: MailOpen,
  clicked: MousePointerClick,
  unsubscribed: MailMinus,
  canceled: CircleSlash,
  created: Globe,
  records: ListChecks,
  verified: CircleCheck,
  draft: FilePen,
}

/**
 * The pill's colours and the icon's, per tone; each works on both themes.
 *
 * ⚠ THE TONE IS AN ATTRIBUTE, NOT A CLASS. A step's tone and whether it has
 * happened are data, and a skeleton cannot know them; as `data-tone` the class
 * list is the same on every node, so test/skeleton-parity can tell a real
 * difference from a colour. `pending` is a tone of its own: the dimmed one.
 */
const PILL =
  "bg-muted text-foreground/80 data-[tone=pending]:bg-muted/60 data-[tone=pending]:text-muted-foreground/70 data-[tone=info]:bg-info/12 data-[tone=info]:text-info data-[tone=success]:bg-success/12 data-[tone=success]:text-success data-[tone=warning]:bg-warning/14 data-[tone=warning]:text-warning data-[tone=danger]:bg-danger/12 data-[tone=danger]:text-danger data-[tone=violet]:bg-info/14 data-[tone=violet]:text-info"
const ICON =
  "text-foreground/80 data-[tone=pending]:text-muted-foreground/40 data-[tone=info]:text-info data-[tone=success]:text-success data-[tone=warning]:text-warning data-[tone=danger]:text-danger data-[tone=violet]:text-info"

const EASE = [0.22, 1, 0.36, 1] as const

const DOT_MASK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14'%3E%3Crect width='2' height='2'/%3E%3C/svg%3E")`
const DOTS: React.CSSProperties = {
  maskImage: DOT_MASK,
  WebkitMaskImage: DOT_MASK,
  maskSize: "14px 14px",
  WebkitMaskSize: "14px 14px",
}

/**
 * A resource's trip, left to right: Resend's "Email events" and "Domain
 * events" strip, under a detail page's header.
 *
 * ⚠ IT TELLS THE STORY, AND DRAWS IT IN ORDER. Each node rises in after the
 * one before and the line between them draws across, so the eye follows the
 * trip once, the way it happened. With reduced motion everything is simply
 * there.
 *
 * ⚠ IT SCROLLS SIDEWAYS ON A NARROW SCREEN rather than wrapping: a trip that
 * wraps onto a second row reads as two trips.
 */
/**
 * The line across the top of the strip that says where things stand -
 * "Looking for DNS records: ..." - as Resend writes it into its events box.
 *
 * ⚠ INSIDE THE BOX, NOT A SEPARATE CARD ABOVE OR BELOW IT (2026-10-03). It
 * was a bordered note under the strip plus a spinner line under that: three
 * stacked things saying one thing. The strip is the story; this is its caption.
 */
export interface JourneyNotice {
  tone: "warning" | "danger" | "neutral"
  title: string
  body: React.ReactNode
  /** Still being worked on: a spinner instead of an alert glyph. */
  busy?: boolean
}

const NOTICE_TONE: Record<JourneyNotice["tone"], { strip: string; icon: string }> = {
  warning: {
    strip: "border-warning/30",
    icon: "text-warning",
  },
  danger: {
    strip: "border-danger/30",
    icon: "text-danger",
  },
  neutral: {
    strip: "",
    icon: "text-muted-foreground",
  },
}

export function Journey({
  title,
  steps,
  notice,
  footer,
}: {
  title: string
  steps: JourneyStep[] | number
  notice?: JourneyNotice | null
  /** Under the strip: what is happening to it right now (set-up's connection). */
  footer?: React.ReactNode
}) {
  const reduce = useReducedMotion()
  const delay = (i: number) => (reduce ? 0 : 0.08 + i * 0.12)
  const loading = typeof steps === "number"
  const list: (JourneyStep | undefined)[] =
    typeof steps === "number" ? Array.from({ length: steps }) : steps

  return (
    <section aria-label={title}>
      <h2 className="text-xs text-muted-foreground">{title}</h2>
      {/*
       * ⚠ THE NOTICE IS ITS OWN BOX ABOVE THE STRIP, AND THE STRIP HAS NO
       * FRAME - Resend's layout, copied on purpose (2026-10-03). The dots are
       * the strip's edge; a border around them as well was a box in a box.
       */}
      {notice && (
        <div
          role="status"
          className={cn(
            "mt-3 flex items-start gap-3 rounded-2xl border px-4 py-3.5 text-sm sm:px-5",
            NOTICE_TONE[notice.tone].strip,
          )}
        >
          {notice.busy ? (
            <LoaderCircle
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0 motion-safe:animate-spin",
                NOTICE_TONE[notice.tone].icon,
              )}
            />
          ) : (
            <CircleAlert
              aria-hidden
              className={cn("mt-0.5 size-4 shrink-0", NOTICE_TONE[notice.tone].icon)}
            />
          )}
          {/*
           * ⚠ THE CAPTION'S HEIGHT ANIMATES. A lookup that comes back with a
           * longer reason ("We cannot see the record yet...") wraps to a second
           * line, and the box grew in one frame, dropping everything under it.
           */}
          <AutoHeight className="min-w-0 flex-1" grow="animate">
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">{notice.title}:</span>{" "}
              {notice.body}
            </p>
          </AutoHeight>
        </div>
      )}
      <div className="relative mt-3 overflow-x-auto">
        {/*
         * ⚠ THE DOTS ARE THEIR OWN LAYER, UNDER THE LIST, AND THE LINE BETWEEN
         * STEPS IS SOLID (2026-10-03). It was dashed where the trip had not gone
         * yet - dashes in the same grey and at the same size as the dots - so a
         * step not yet reached and the empty background read as one texture.
         * A continuous rule cannot be mistaken for the pattern behind it.
         */}
        {/*
         * ⚠ SQUARE DOTS, AS RESEND DRAWS THEM: the border colour, cut into 2px
         * squares by a mask. A mask rather than an SVG background because a
         * data URI cannot read a CSS variable, and the colour has to follow
         * the theme.
         */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-border"
          style={DOTS}
        />
        <BoneScope id="journey" loading={loading}>
          <ol className="relative flex min-w-max px-4 py-7 sm:px-8">
            {list.map((step, i) => {
              const next = list[i + 1]
              return (
                <BoneScope key={step?.key ?? i} id={`step-${i}`} unit>
                  <li className="relative flex w-40 flex-1 flex-col items-center sm:w-44">
                    {(next !== undefined || i < list.length - 1) && (
                      <Connector
                        reached={Boolean(next && next.state !== "pending")}
                        current={Boolean(next && next.state === "current")}
                        delay={delay(i) + 0.1}
                        reduce={reduce ?? false}
                      />
                    )}
                    <Node step={step} delay={delay(i)} reduce={reduce ?? false} />
                  </li>
                </BoneScope>
              )
            })}
          </ol>
        </BoneScope>
      </div>
      {footer}
    </section>
  )
}

function Connector({
  reached,
  current,
  delay,
  reduce,
}: {
  reached: boolean
  current: boolean
  delay: number
  reduce: boolean
}) {
  return (
    <div
      aria-hidden
      /*
       * ⚠ EDGE TO EDGE, 3PX, CENTRED ON THE NODES (2026-10-03). It used to stop
       * 4px short of each node at 1px, which read as a dotted gap rather than a
       * connection; it now starts where one 40px node's border ends and runs
       * into the next one's, the way Resend's does.
       */
      className="absolute top-[calc(1.25rem-1.5px)] left-[calc(50%+1.25rem)] h-[3px] w-[calc(100%-2.5rem)]"
    >
      {/*
       * The track, always there and always solid; the part the trip has
       * covered is drawn over it in a stronger ink.
       */}
      <div className="absolute inset-0 rounded-full bg-foreground/15" />
      {/*
       * ⚠ THE LINE INTO THE STEP IN PROGRESS CARRIES A PULSE (2026-10-03): a
       * short bright band that runs along it on a loop, so the strip reads as
       * working rather than as a picture of a step. Nothing moves with reduced
       * motion; the spinner's tone still says the step is live.
       */}
      {current && !reduce && (
        <div
          data-skeleton="skip"
          className="absolute inset-0 overflow-hidden rounded-full"
        >
          {/*
           * ⚠ A CSS ANIMATION, NOT MOTION. It loops forever on a page left open
           * for an afternoon; the compositor runs it without waking React, and
           * it keeps its place when the tab is in the background.
           */}
          <div
            className="absolute inset-y-0 w-1/3 animate-[journey-pulse_2s_ease-in-out_infinite]"
            style={{ animationDelay: `${delay + 0.45}s` }}
          />
        </div>
      )}
      {/* ⚠ SKIPPED BY test/skeleton-parity: how far the trip has got is data, drawn over the track. */}
      {reached && (
        <motion.div
          data-skeleton="skip"
          className={cn(
            "absolute inset-0 origin-left rounded-full",
            current
              ? "bg-[linear-gradient(to_right,var(--foreground),transparent)] opacity-40"
              : "bg-foreground/35",
          )}
          initial={reduce ? false : { scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.45, delay, ease: EASE }}
        />
      )}
    </div>
  )
}

function Node({
  step,
  delay,
  reduce,
}: {
  step?: JourneyStep
  delay: number
  reduce: boolean
}) {
  const Icon = step ? ICONS[step.icon] : null
  const pending = step ? step.state === "pending" : true
  const current = step ? step.state === "current" : false
  // `pending` is dimmed whatever the tone; a skeleton has no tone to give.
  const tone = step ? (pending ? "pending" : step.tone) : "pending"

  /*
   * ⚠ THE NODE IS THE SAME ELEMENT WITH OR WITHOUT A TIME (2026-10-13). The
   * tooltip used to wrap the whole node only once the step had a time, so the
   * first DNS check - which gives "Checking DNS" its "Last checked" - changed
   * the tree, React mounted a new node and its entrance played again: the
   * step flashed out and back a second or two after the page loaded. Now the
   * animated node and its icon never change shape; only the label and time
   * take the tooltip.
   */
  const label = (
    <div className="flex flex-col items-center">
      <span
        data-tone={tone}
        className={cn(
          "mt-3 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap",
          PILL,
        )}
      >
        <Bone id="label" width={64} lineHeight={16} inline>
          {step?.label}
          {step?.count && step.count > 1 && (
            <span className="tabular opacity-70">×{step.count}</span>
          )}
        </Bone>
      </span>
      <StepTime step={step} />
    </div>
  )

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 6, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.35, delay, ease: EASE }}
      className="flex flex-col items-center text-center"
    >
      <div className="relative">
        <div
          data-tone={tone}
          // ⚠ IT DOES NOT MOVE ON HOVER (2026-10-03). The tooltip is the
          // answer to the pointer; a node that hops up is only motion.
          // ⚠ A SOLID EDGE, DIMMED - NOT DASHED, for a step not yet reached
          // (2026-10-03): a dashed ring read as a second dotted pattern on
          // top of the dots behind it.
          className={cn(
            "relative grid size-10 place-items-center rounded-xl border",
            ICON,
          )}
        >
          {/*
           * ⚠ THE STEP IN PROGRESS SPINS, IN ITS TONE, AS RESEND'S DOES - it
           * replaced a ring that pulsed outward from the node, which read as
           * an alert rather than as work going on.
           */}
          <Bone id="icon" shape="box" width={18} height={18} radius={4} inline>
            {current ? (
              <LoaderCircle className="size-[18px] motion-safe:animate-spin" />
            ) : Icon ? (
              <Icon className="size-[18px]" />
            ) : null}
          </Bone>
        </div>
      </div>
      {step?.at ? (
        <Tooltip content={<ExactTime iso={step.at} />}>
          <div className="cursor-default">{label}</div>
        </Tooltip>
      ) : (
        <div className="cursor-default">{label}</div>
      )}
    </motion.div>
  )
}

/**
 * "Jul 26" over "9:41 AM", in the reader's own time zone once mounted and in
 * UTC before - the server's render and the browser's must agree, or React
 * throws the server HTML away.
 */
function StepTime({ step }: { step?: JourneyStep }) {
  const mounted = useMounted()
  if (!step) {
    return <Bone id="time" width={72} lineHeight={16} className="mt-1.5" />
  }
  if (!step.at) {
    return (
      <Bone id="time" width={72} lineHeight={16} className="mt-1.5">
        <span
          className={cn(
            "text-xs text-muted-foreground",
            step.state === "pending" && "opacity-60",
          )}
        >
          {step.note ?? (step.state === "current" ? "In progress" : "Not yet")}
        </span>
      </Bone>
    )
  }
  const date = new Date(step.at)
  const zone = mounted ? undefined : "UTC"
  // "Oct 03, 6:20 PM" on one line, as Resend writes it.
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: zone,
  })
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
  })
  return (
    <Bone id="time" width={72} lineHeight={16} className="mt-1.5">
      <span className="tabular flex flex-col text-xs leading-relaxed text-muted-foreground">
        {step.note && <span>{step.note}</span>}
        <time dateTime={step.at} className="whitespace-nowrap">
          {day}, {time}
        </time>
      </span>
    </Bone>
  )
}

function ExactTime({ iso }: { iso: string }) {
  const exact = useExactTime()
  return <span className="tabular">{exact(iso)}</span>
}
