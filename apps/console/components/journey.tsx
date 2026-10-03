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
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { cn } from "cn"
import { formatExact } from "@/lib/format"
import type { JourneyIcon, JourneyStep, JourneyTone } from "@/lib/journey"
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

/** The pill's colours and the icon's, per tone; each works on both themes. */
const TONE: Record<JourneyTone, { pill: string; icon: string; glow: string }> = {
  neutral: {
    pill: "bg-muted text-foreground/80",
    icon: "text-foreground/80",
    glow: "shadow-foreground/10",
  },
  info: {
    pill: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
    icon: "text-sky-600 dark:text-sky-400",
    glow: "shadow-sky-500/25",
  },
  success: {
    pill: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    icon: "text-emerald-600 dark:text-emerald-400",
    glow: "shadow-emerald-500/25",
  },
  warning: {
    pill: "bg-amber-500/14 text-amber-800 dark:text-amber-300",
    icon: "text-amber-600 dark:text-amber-400",
    glow: "shadow-amber-500/25",
  },
  danger: {
    pill: "bg-red-500/12 text-red-700 dark:text-red-300",
    icon: "text-red-600 dark:text-red-400",
    glow: "shadow-red-500/25",
  },
  violet: {
    pill: "bg-violet-500/14 text-violet-700 dark:text-violet-300",
    icon: "text-violet-600 dark:text-violet-400",
    glow: "shadow-violet-500/25",
  },
}

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
    strip:
      "border-warning/30 bg-linear-to-r from-warning/15 via-warning/5 to-transparent",
    icon: "text-warning",
  },
  danger: {
    strip: "border-danger/30 bg-linear-to-r from-danger/15 via-danger/5 to-transparent",
    icon: "text-danger",
  },
  neutral: {
    strip: "bg-linear-to-r from-muted/70 to-transparent",
    icon: "text-muted-foreground",
  },
}

export function Journey({
  title,
  steps,
  notice,
}: {
  title: string
  steps: JourneyStep[]
  notice?: JourneyNotice | null
}) {
  const reduce = useReducedMotion()
  const delay = (i: number) => (reduce ? 0 : 0.08 + i * 0.12)

  return (
    <section aria-label={title}>
      <h2 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </h2>
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
          <p className="min-w-0 text-muted-foreground">
            <span className="font-medium text-foreground">{notice.title}:</span>{" "}
            {notice.body}
          </p>
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
        <ol className="relative flex min-w-max px-4 py-7 sm:px-8">
          {steps.map((step, i) => {
            const next = steps[i + 1]
            return (
              <li
                key={`${step.key}-${i}`}
                className="relative flex w-40 flex-1 flex-col items-center sm:w-44"
              >
                {next && (
                  <Connector
                    reached={next.state !== "pending"}
                    current={next.state === "current"}
                    delay={delay(i) + 0.1}
                    reduce={reduce ?? false}
                  />
                )}
                <Node step={step} delay={delay(i)} reduce={reduce ?? false} />
              </li>
            )
          })}
        </ol>
      </div>
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
        <div className="absolute inset-0 overflow-hidden rounded-full">
          {/*
           * ⚠ A CSS ANIMATION, NOT MOTION. It loops forever on a page left open
           * for an afternoon; the compositor runs it without waking React, and
           * it keeps its place when the tab is in the background.
           */}
          <div
            className="absolute inset-y-0 w-1/3 animate-[journey-pulse_2s_ease-in-out_infinite] bg-linear-to-r from-transparent via-warning to-transparent"
            style={{ animationDelay: `${delay + 0.45}s` }}
          />
        </div>
      )}
      {reached && (
        <motion.div
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
  step: JourneyStep
  delay: number
  reduce: boolean
}) {
  const Icon = ICONS[step.icon]
  const tone = TONE[step.tone]
  const pending = step.state === "pending"
  const current = step.state === "current"

  const node = (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 6, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.35, delay, ease: EASE }}
      className="flex flex-col items-center text-center"
    >
      <div className="relative">
        <div
          className={cn(
            // ⚠ IT DOES NOT MOVE ON HOVER (2026-10-03). The tooltip is the
            // answer to the pointer; a node that hops up is only motion.
            "relative grid size-10 place-items-center rounded-xl border bg-linear-to-b from-muted/80 to-background",
            pending
              ? // ⚠ A SOLID EDGE, DIMMED - NOT DASHED (2026-10-03). A dashed ring
                // round a step not yet reached read as a second dotted pattern
                // on top of the dots behind it.
                "text-muted-foreground/40"
              : cn("shadow-lg", tone.glow, tone.icon),
          )}
        >
          {/*
           * ⚠ THE STEP IN PROGRESS SPINS, IN ITS TONE, AS RESEND'S DOES - it
           * replaced a ring that pulsed outward from the node, which read as
           * an alert rather than as work going on.
           */}
          {current ? (
            <LoaderCircle className="size-[18px] motion-safe:animate-spin" />
          ) : (
            <Icon className="size-[18px]" />
          )}
        </div>
      </div>
      <span
        className={cn(
          "mt-3 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap",
          pending ? "bg-muted/60 text-muted-foreground/70" : tone.pill,
        )}
      >
        {step.label}
        {step.count && step.count > 1 && (
          <span className="tabular opacity-70">×{step.count}</span>
        )}
      </span>
      <StepTime step={step} />
    </motion.div>
  )

  if (!step.at) return node
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-default">{node}</div>
      </TooltipTrigger>
      <TooltipContent>
        <ExactTime iso={step.at} />
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * "Jul 26" over "9:41 AM", in the reader's own time zone once mounted and in
 * UTC before - the server's render and the browser's must agree, or React
 * throws the server HTML away.
 */
function StepTime({ step }: { step: JourneyStep }) {
  const mounted = useMounted()
  if (!step.at) {
    return (
      <span
        className={cn(
          "mt-1.5 text-xs text-muted-foreground",
          step.state === "pending" && "opacity-60",
        )}
      >
        {step.note ?? (step.state === "current" ? "In progress" : "Not yet")}
      </span>
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
    <span className="tabular mt-1.5 flex flex-col text-xs leading-relaxed text-muted-foreground">
      {step.note && <span>{step.note}</span>}
      <time dateTime={step.at} className="whitespace-nowrap">
        {day}, {time}
      </time>
    </span>
  )
}

function ExactTime({ iso }: { iso: string }) {
  const mounted = useMounted()
  return <span className="tabular">{mounted ? formatExact(iso) : iso}</span>
}
