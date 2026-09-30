"use client"

import { AnimatePresence, motion } from "motion/react"
import { useEffect, useState } from "react"
import { cn } from "cn"

type Status = "operational" | "degraded" | "unreachable"
type Probe = { status: Status; latencyMs?: number; checkedAt: string }

const COPY: Record<Status | "checking", string> = {
  checking: "Checking",
  operational: "All systems operational",
  degraded: "Degraded performance",
  unreachable: "Status unavailable",
}

const TONE: Record<Status, string> = {
  operational: "var(--state-delivered)",
  degraded: "var(--state-complained)",
  unreachable: "var(--fg-4)",
}

const SLOTS = 48
const EVERY = 30_000

/*
 * A status page that only shows what it measured. Every bar is one probe of
 * api.i10.tech made while this page has been open (through /api/status, which
 * caches for 30s, so the page polls on the same beat). There is no invented
 * ninety-day history: the empty slots stay empty until they are measured.
 *
 * The other components are listed so the page has its eventual shape, and
 * each says plainly that it is not probed from here yet.
 */
export function StatusBoard() {
  const [probes, setProbes] = useState<Probe[]>([])

  useEffect(() => {
    let alive = true
    const probe = () =>
      fetch("/api/status", { cache: "no-store" })
        .then((r) => r.json() as Promise<Probe>)
        .catch((): Probe => ({ status: "unreachable", checkedAt: new Date().toISOString() }))
        .then((p) => alive && setProbes((prev) => [...prev, p].slice(-SLOTS)))
    probe()
    const id = setInterval(probe, EVERY)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const latest = probes.at(-1)
  const state = latest?.status ?? "checking"
  const tone = latest ? TONE[latest.status] : "var(--fg-4)"
  const slots = Array.from({ length: SLOTS }, (_, i) => probes[i - (SLOTS - probes.length)])

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-[22px] bg-surface-1 p-6 shadow-[inset_0_0_0_1px_var(--line)] md:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -left-24 size-[320px] rounded-full opacity-25 blur-[80px] transition-colors duration-700"
          style={{ background: tone }}
        />
        <div className="relative flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <span className="relative flex size-3 items-center justify-center">
              {state === "operational" ? <span className="status-ping absolute inset-0 rounded-full bg-delivered" /> : null}
              <span className="relative size-3 rounded-full transition-colors duration-500" style={{ background: tone }} />
            </span>
            <div className="grid">
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={state}
                  initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
                  transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                  className="col-start-1 row-start-1 text-[22px] leading-8 font-[560] tracking-[-0.02em] text-fg"
                >
                  {COPY[state]}
                </motion.span>
              </AnimatePresence>
            </div>
          </div>
          <span className="font-mono text-[11.5px] text-fg-4 tabular-nums">
            {latest ? `Checked ${new Date(latest.checkedAt).toLocaleTimeString("en-GB")}` : "Probing api.i10.tech"}
          </span>
        </div>

        <div className="relative mt-10">
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-fg">API</span>
            <span className="font-mono text-[11.5px] text-fg-3 tabular-nums">
              {latest?.latencyMs != null ? `${latest.latencyMs} ms` : " "}
            </span>
          </div>
          <div className="mt-3 flex h-9 gap-[3px]" role="img" aria-label={`${probes.length} probes of the API since this page opened`}>
            {slots.map((p, i) => (
              <span
                key={i}
                className={cn("flex-1 rounded-[2px] transition-colors duration-500", !p && "bg-white/[0.05]")}
                style={p ? { background: TONE[p.status] } : undefined}
              />
            ))}
          </div>
          <div className="mt-2.5 flex justify-between font-mono text-[10.5px] text-fg-4">
            <span>{SLOTS * (EVERY / 1000 / 60)} minutes</span>
            <span>Now</span>
          </div>
        </div>
      </div>

      <ul className="overflow-hidden rounded-[22px] bg-surface-1 shadow-[inset_0_0_0_1px_var(--line)]">
        {["Sending", "Webhooks", "Mailboxes", "Console"].map((name) => (
          <li key={name} className="flex items-center justify-between border-t border-line-faint px-6 py-4 first:border-t-0 md:px-8">
            <span className="text-[14px] text-fg-2">{name}</span>
            <span className="font-mono text-[11px] text-fg-4">Not probed from this page yet</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
