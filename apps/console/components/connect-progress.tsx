"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { Check, TriangleAlert } from "lucide-react"
import { Spinner } from "@repo/ui/components/i10/spinner"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { TextShimmer } from "@repo/ui/components/text-shimmer/text-shimmer"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { useRetained } from "@/lib/react"
import { stageProblem, type ConnectPhase, type DomainStage } from "@/lib/dns-connect"

/** Where set-up is with a connection that came back from the provider. */
export interface ConnectView {
  /** The provider's name, as the person chose it ("Cloudflare"). */
  name: string
  phase: ConnectPhase
  /** Why the connection did not complete. Set with `failed`. */
  error?: string
  /** This page's domain, once the run has reached it. */
  stage: DomainStage | null
}

type Row = { key: string; label: string; state: "done" | "current" | "halted" }

/**
 * The lines for one domain, from what actually happened to it.
 *
 * ⚠ A LINE IS TICKED ONLY FOR A STEP THAT HAPPENED. The list used to be cut
 * from one run-wide phase, so a run that finished ticked "Publishing your
 * records" and "Checking them" for a domain the provider had refused, and then
 * waited on propagation for records that did not exist.
 */
export function progressRows(view: ConnectView, verified: boolean): Row[] {
  const connecting = `Finishing the connection with ${view.name}`
  if (view.phase === "connecting")
    return [{ key: "connecting", label: connecting, state: "current" }]
  if (view.phase === "failed")
    return [
      { key: "connecting", label: "The connection did not complete", state: "halted" },
    ]

  const connected: Row = { key: "connecting", label: connecting, state: "done" }
  const publishing = (state: Row["state"], label = "Publishing your records"): Row => ({
    key: "publishing",
    label,
    state,
  })
  const stage = view.stage
  if (!stage) return [connected]
  switch (stage.kind) {
    case "publishing":
      return [connected, publishing("current")]
    case "checking":
      return [
        connected,
        publishing("done"),
        { key: "checking", label: "Checking them", state: "current" },
      ]
    case "published":
      return [
        connected,
        publishing("done"),
        // ⚠ NOT TICKED WHEN THE CHECK DID NOT ANSWER - the note below says so.
        ...(stage.checked
          ? [{ key: "checking", label: "Checking them", state: "done" } as const]
          : []),
        {
          key: "propagating",
          label: verified
            ? "Verified - ready to send"
            : "Waiting for DNS records to propagate",
          state: verified ? "done" : "current",
        },
      ]
    case "blocked":
      return [connected, publishing("halted", "Your records are not published yet")]
    case "unreachable":
      return [connected, publishing("halted", "We did not publish your records")]
    case "failed":
      return [connected, publishing("halted", "We could not publish your records")]
  }
}

/**
 * The provider round trip, finished in place under the domain's events
 * (2026-10-13): each step arrives as its own line, the one before it ticks,
 * and the last one waits on DNS until the domain is verified.
 */
export function ConnectProgress({
  view,
  verified,
  domainName,
}: {
  view: ConnectView
  verified: boolean
  domainName: string
}) {
  const reduce = useReducedMotion() ?? false
  const rows = progressRows(view, verified)
  const stage = view.stage
  const settled =
    stage && stage.kind !== "publishing" && stage.kind !== "checking" ? stage : null
  const problem =
    view.phase === "failed"
      ? (view.error ?? null)
      : settled
        ? stageProblem(settled, domainName, view.name)
        : null
  const published = settled?.kind === "published"
  const shownProblem = useRetained(problem)

  return (
    <div className="mt-3 rounded-2xl border px-4 py-3.5 sm:px-5" role="status">
      <ul className="space-y-2.5">
        <AnimatePresence initial={false}>
          {rows.map((row) => {
            const halted = row.state === "halted"
            const current = row.state === "current"
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
                  {halted ? (
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
                    className={halted ? "text-foreground" : "text-muted-foreground"}
                  >
                    {row.label}
                  </span>
                )}
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
      <Reveal show={problem !== null} spacing="mt-2 pl-7">
        <p className="text-sm text-muted-foreground">{shownProblem}</p>
      </Reveal>
      <Reveal
        show={settled?.kind === "published" && !settled.checked}
        spacing="mt-2 pl-7"
      >
        <p className="text-sm text-muted-foreground">
          The records are in place, but the first check did not answer. We keep checking
          on our own.
        </p>
      </Reveal>
      <Reveal show={published && !verified} spacing="mt-2 pl-7">
        <p className="text-xs text-muted-foreground">
          Propagation is usually minutes and can take up to 72 hours - nothing is wrong
          yet. This updates by itself.
        </p>
      </Reveal>
    </div>
  )
}
