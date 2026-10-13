"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Check, TriangleAlert } from "lucide-react"
import { Spinner } from "@repo/ui/components/i10/spinner"
import { TextShimmer } from "@repo/ui/components/text-shimmer/text-shimmer"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import type { ConnectPhase } from "@/lib/dns-connect"

/** Where set-up is with a connection that came back from the provider. */
export interface ConnectView {
  /** The provider's name, as the person chose it ("Cloudflare"). */
  name: string
  phase: ConnectPhase
  error?: string
  blocked: string[]
  unchecked: string[]
}

type Row = { key: string; label: string }

/**
 * The provider round trip, finished in place under the domain's events
 * (2026-10-13): each phase arrives as its own line, the one before it ticks,
 * and the last one waits on DNS until the domain is verified.
 */
export function ConnectProgress({
  view,
  verified,
}: {
  view: ConnectView
  verified: boolean
}) {
  const reduce = useReducedMotion() ?? false
  const rows: Row[] = [
    { key: "connecting", label: `Finishing the connection with ${view.name}` },
    { key: "publishing", label: "Publishing your records" },
    { key: "checking", label: "Checking them" },
    {
      key: "propagating",
      label: verified
        ? "Verified - ready to send"
        : "Waiting for DNS records to propagate",
    },
  ]
  const order = ["connecting", "publishing", "checking", "done"]
  const reached =
    view.phase === "failed" ? -1 : view.phase === "done" ? 3 : order.indexOf(view.phase)
  const shown = view.phase === "failed" ? rows.slice(0, 1) : rows.slice(0, reached + 1)

  return (
    <div className="mt-3 rounded-2xl border px-4 py-3.5 sm:px-5" role="status">
      <ul className="space-y-2.5">
        <AnimatePresence initial={false}>
          {shown.map((row, i) => {
            const failed = view.phase === "failed"
            const current = !failed && i === shown.length - 1 && !(i === 3 && verified)
            return (
              <motion.li
                key={row.key}
                layout={reduce ? false : "position"}
                initial={
                  reduce
                    ? false
                    : {
                        opacity: 0,
                        y: -4,
                        filter: `blur(${motionTokens.blur.subtle}px)`,
                      }
                }
                animate={{
                  opacity: 1,
                  y: 0,
                  filter: "blur(0px)",
                  transitionEnd: { filter: "none" },
                }}
                transition={{
                  ...motionTokens.spring.smooth,
                  opacity: {
                    duration: motionTokens.duration.standard,
                    ease: [...motionTokens.ease.enter],
                  },
                }}
                className="flex items-center gap-3 text-sm"
              >
                <span className="grid size-4 shrink-0 place-items-center">
                  {failed ? (
                    <TriangleAlert className="size-4 text-danger" aria-hidden />
                  ) : current ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <motion.span
                      initial={reduce ? false : { scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={motionTokens.spring.snappy}
                      className="grid place-items-center"
                    >
                      <Check className="size-4 text-success" aria-hidden />
                    </motion.span>
                  )}
                </span>
                {current ? (
                  <TextShimmer as="span" className="text-muted-foreground">
                    {row.label}
                  </TextShimmer>
                ) : (
                  <span
                    className={failed ? "text-foreground" : "text-muted-foreground"}
                  >
                    {failed ? "The connection did not complete" : row.label}
                  </span>
                )}
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
      {view.phase === "failed" && view.error && (
        <p className="mt-2 pl-7 text-sm text-muted-foreground">{view.error}</p>
      )}
      {view.phase === "done" && view.blocked.length > 0 && (
        <p className="mt-2 pl-7 text-sm text-muted-foreground">
          {view.blocked.join(", ")} already {view.blocked.length === 1 ? "has" : "have"}{" "}
          records at the names we need. Open the domain to choose whether to replace
          them.
        </p>
      )}
      {view.phase === "done" && view.unchecked.length > 0 && (
        <p className="mt-2 pl-7 text-sm text-muted-foreground">
          The records are in place, but the first check did not answer. We keep checking
          on our own.
        </p>
      )}
      {view.phase === "done" && !verified && (
        <p className="mt-2 pl-7 text-xs text-muted-foreground">
          Propagation is usually minutes and can take up to 72 hours - nothing is wrong
          yet. This updates by itself.
        </p>
      )}
    </div>
  )
}
