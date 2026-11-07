"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { cn } from "cn"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { Badge, type BadgeTone } from "@repo/ui/components/badge/badge"

/**
 * The pieces every settled SSO screen is built from, so no screen invents its
 * own panel: a group of hairline rows, a state said as chip + sentence + one
 * button, and advanced settings that stay shut until asked for.
 */

export function SettingsGroup({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "divide-y divide-border overflow-hidden rounded-2xl border border-border",
        className,
      )}
    >
      {children}
    </div>
  )
}

/** A row: what it is on the left, its control on the right, more underneath. */
export function SettingsRow({
  title,
  description,
  action,
  children,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          {description && (
            <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  )
}

/** Where something stands: one chip, one sentence, at most one button. */
export function StatusLine({
  label,
  tone,
  sentence,
  action,
}: {
  label: string
  tone: BadgeTone
  sentence: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Badge tone={tone} size="sm">
        {label}
      </Badge>
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">{sentence}</p>
      {action}
    </div>
  )
}

/** Settings most people never need. Shut by default, and it says what is inside. */
export function Advanced({
  label = "Advanced",
  summary,
  defaultOpen = false,
  children,
}: {
  label?: string
  summary?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const reduced = useReducedMotion()
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 py-1 text-left text-sm"
      >
        <span>
          <span className="font-medium">{label}</span>
          {summary && !open && (
            <span className="ml-2 text-muted-foreground">{summary}</span>
          )}
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={reduced ? { duration: 0 } : motionTokens.spring.snappy}
        >
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
        </motion.span>
      </button>
      <Reveal show={open} spacing="pt-3" keepMounted>
        {children}
      </Reveal>
    </div>
  )
}
