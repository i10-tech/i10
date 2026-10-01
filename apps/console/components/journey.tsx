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
  FilePen,
  Flag,
  Globe,
  Hourglass,
  ListChecks,
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
export function Journey({ title, steps }: { title: string; steps: JourneyStep[] }) {
  const reduce = useReducedMotion()
  const delay = (i: number) => (reduce ? 0 : 0.08 + i * 0.12)

  return (
    <section aria-label={title}>
      <h2 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
        {title}
      </h2>
      <div
        className={cn(
          "relative mt-3 overflow-x-auto rounded-2xl border",
          "bg-[radial-gradient(circle,var(--border)_1px,transparent_1.2px)] [background-size:14px_14px]",
        )}
      >
        {/* A soft fade at the edges, so the dots end rather than stop. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-2xl bg-[radial-gradient(ellipse_at_center,transparent_40%,var(--background)_100%)] opacity-70"
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
      className="absolute top-5 left-[calc(50%+1.5rem)] h-px w-[calc(100%-3rem)]"
    >
      {/* The track, always there; dashed where the trip has not gone yet. */}
      <div
        className={cn(
          "absolute inset-0",
          reached
            ? "bg-border"
            : "bg-[linear-gradient(to_right,var(--border)_50%,transparent_50%)] [background-size:8px_1px]",
        )}
      />
      {reached && (
        <motion.div
          className={cn(
            "absolute inset-0 origin-left",
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
        {current && !reduce && (
          <motion.span
            aria-hidden
            className={cn(
              "absolute inset-0 rounded-xl border",
              tone.icon,
              "border-current",
            )}
            animate={{ opacity: [0.5, 0], scale: [1, 1.35] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <div
          className={cn(
            "relative grid size-10 place-items-center rounded-xl border bg-background",
            "transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5",
            pending
              ? "border-dashed text-muted-foreground/50"
              : cn("shadow-lg", tone.glow, tone.icon),
          )}
        >
          <Icon className="size-[18px]" />
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
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
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
      <time dateTime={step.at}>{day}</time>
      <span>{time}</span>
    </span>
  )
}

function ExactTime({ iso }: { iso: string }) {
  const mounted = useMounted()
  return <span className="tabular">{mounted ? formatExact(iso) : iso}</span>
}
