"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { cn } from "cn"

type Status = "checking" | "operational" | "degraded" | "unreachable"

const COPY: Record<Status, string> = {
  checking: "Checking status",
  operational: "All systems operational",
  degraded: "Degraded performance",
  unreachable: "Status unavailable",
}

const DOT: Record<Status, string> = {
  checking: "bg-fg-4",
  operational: "bg-delivered",
  degraded: "bg-complained",
  unreachable: "bg-fg-4",
}

/*
 * Resend's pill, measured rather than asserted: it reads /api/status, which
 * probes the live API. Only "operational" pulses; a grey dot never pretends.
 *
 * ⚠ THE LABEL WIDTH IS RESERVED. Every label sits in one grid cell and only
 * the current one is visible, so the pill is as wide as its longest state and
 * the answer arriving moves nothing around it.
 */
export function StatusPill({ className }: { className?: string }) {
  const [status, setStatus] = useState<Status>("checking")

  useEffect(() => {
    let alive = true
    fetch("/api/status")
      .then((r) => r.json() as Promise<{ status: Status }>)
      .then((d) => alive && setStatus(d.status))
      .catch(() => alive && setStatus("unreachable"))
    return () => {
      alive = false
    }
  }, [])

  return (
    <Link
      href="/status"
      className={cn(
        "status-pill group relative inline-flex h-[34px] w-fit shrink-0 items-center whitespace-nowrap gap-2.5 overflow-hidden rounded-full pr-4 pl-3.5 text-xs text-fg-2 transition-colors hover:text-fg",
        className,
      )}
    >
      <span className="relative flex size-2 items-center justify-center">
        {status === "operational" ? (
          <span className="status-ping absolute inset-0 rounded-full bg-delivered" />
        ) : null}
        <span
          className={cn(
            "relative size-2 rounded-full transition-colors duration-500",
            DOT[status],
          )}
        />
      </span>
      <span className="grid">
        {(Object.keys(COPY) as Status[]).map((key) => (
          <span
            key={key}
            aria-hidden={key !== status}
            className={cn(
              "col-start-1 row-start-1 transition-opacity duration-300",
              key === status ? "opacity-100" : "opacity-0",
            )}
          >
            {COPY[key]}
          </span>
        ))}
      </span>
    </Link>
  )
}
