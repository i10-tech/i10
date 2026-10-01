"use client"

import { AnimatePresence, motion } from "motion/react"
import { useEffect, useRef, useState } from "react"
import { cn } from "cn"
import { Mark } from "@/components/brand/mark"
import { PixelIcon } from "@/components/brand/pixel-icon"
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/gsap"
import type { IconName } from "@/lib/site"

/*
 * The console, as a teaser that plays.
 *
 * The window starts tilted back and a little small, and rises into focus as
 * you scroll to it (Attio, Linear). Once it is on screen it runs a loop the
 * real product runs all day: a send is accepted, signed, handed to SES and
 * delivered, and the timeline on the right follows the newest message.
 *
 * Every label in the sidebar is a real console area; the data is fictional.
 */
type Status = "queued" | "sent" | "delivered" | "opened" | "bounced"

interface Row {
  id: number
  to: string
  subject: string
  status: Status
  at: string
}

const SEED: Omit<Row, "id" | "status" | "at">[] = [
  { to: "maya@northwind.dev", subject: "Confirm your email address" },
  { to: "leo@parcel.so", subject: "Your receipt from Acme" },
  { to: "ops@kestrel.io", subject: "New sign-in from Berlin" },
  { to: "ines@fieldnotes.app", subject: "Invoice #2041 is ready" },
  { to: "sam@lattice.dev", subject: "Reset your password" },
  { to: "noor@harbor.co", subject: "Your export is ready" },
  { to: "tomas@orbit.fm", subject: "Welcome aboard, Tomas" },
  { to: "ada@quill.page", subject: "Weekly summary: 3 new signups" },
  { to: "kai@driftwood.sh", subject: "Magic link for Driftwood" },
  { to: "billing@mosaic.ai", subject: "Payment received, thank you" },
]

const INITIAL: Row[] = [
  {
    id: 1,
    to: "hello@acme.co",
    subject: "Your trial ends in 3 days",
    status: "opened",
    at: "2m",
  },
  {
    id: 2,
    to: "eli@sparrow.dev",
    subject: "Deploy finished: production",
    status: "delivered",
    at: "4m",
  },
  {
    id: 3,
    to: "nora@typeset.io",
    subject: "Someone mentioned you",
    status: "delivered",
    at: "9m",
  },
  {
    id: 4,
    to: "bounce@nowhere.invalid",
    subject: "Verify your email",
    status: "bounced",
    at: "12m",
  },
  {
    id: 5,
    to: "ravi@loom.works",
    subject: "Invoice #2040 is ready",
    status: "delivered",
    at: "18m",
  },
  {
    id: 6,
    to: "june@atlas.tools",
    subject: "2 new comments on your doc",
    status: "opened",
    at: "26m",
  },
]

const CHIP: Record<Status, { label: string; className: string }> = {
  queued: {
    label: "Queued",
    className: "bg-white/[0.06] text-fg-2 shadow-[inset_0_0_0_1px_var(--line)]",
  },
  sent: {
    label: "Sent",
    className:
      "bg-queued/12 text-queued shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--state-queued)_25%,transparent)]",
  },
  delivered: {
    label: "Delivered",
    className:
      "bg-delivered/12 text-delivered shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--state-delivered)_25%,transparent)]",
  },
  opened: {
    label: "Opened",
    className:
      "bg-hue-mail/12 text-hue-mail shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--hue-mail)_25%,transparent)]",
  },
  bounced: {
    label: "Bounced",
    className:
      "bg-bounced/12 text-bounced shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--state-bounced)_25%,transparent)]",
  },
}

const TIMELINE = [
  { title: "Accepted", detail: "POST /emails · 202", mono: "14:02:11.041" },
  {
    title: "Idempotency checked",
    detail: "key signup-7f3a · first use",
    mono: "14:02:11.043",
  },
  { title: "DKIM signed", detail: "d=acme.co · s=i10", mono: "14:02:11.058" },
  { title: "Handed to SES", detail: "eu-central-1 · Frankfurt", mono: "14:02:11.212" },
  { title: "Delivered", detail: "gmail-smtp-in.l.google.com", mono: "14:02:12.806" },
]

const NAV: { label: string; icon: IconName; active?: boolean; count?: string }[] = [
  { label: "Emails", icon: "send", active: true },
  { label: "Broadcasts", icon: "broadcast" },
  { label: "Contacts", icon: "people", count: "2,418" },
  { label: "Templates", icon: "template" },
  { label: "Domains", icon: "globe" },
  { label: "Mailboxes", icon: "mailbox" },
  { label: "API keys", icon: "key" },
  { label: "Webhooks", icon: "webhook" },
  { label: "Logs", icon: "changelog" },
]

export function ConsoleTeaser() {
  const stage = useRef<HTMLDivElement>(null)
  const win = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      if (prefersReducedMotion() || !win.current) return
      gsap.fromTo(
        win.current,
        { rotateX: 26, scale: 0.86, y: 60, opacity: 0.55 },
        {
          rotateX: 0,
          scale: 1,
          y: 0,
          opacity: 1,
          ease: "none",
          scrollTrigger: {
            trigger: stage.current,
            start: "top 95%",
            end: "top 20%",
            scrub: 0.6,
          },
        },
      )
    },
    { scope: stage },
  )

  return (
    <section data-nav-tone="dark" className="relative pb-24 md:pb-36">
      <div className="container-site">
        <div ref={stage} className="relative [perspective:1800px]">
          <div aria-hidden className="console-halo pointer-events-none absolute" />
          <div
            ref={win}
            className="console-window relative origin-[50%_0%] overflow-hidden rounded-[18px] will-change-transform"
          >
            <ConsoleApp />
          </div>
        </div>
      </div>
    </section>
  )
}

function ConsoleApp() {
  const [rows, setRows] = useState<Row[]>(INITIAL)
  const [step, setStep] = useState(TIMELINE.length)
  const [running, setRunning] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const counter = useRef({ id: 100, seed: 0 })

  // Play only while visible.
  useEffect(() => {
    const el = root.current
    if (!el || prefersReducedMotion()) return
    const io = new IntersectionObserver(
      ([e]) => setRunning(Boolean(e?.isIntersecting)),
      { threshold: 0.25 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!running) return
    const timers: ReturnType<typeof setTimeout>[] = []
    const cycle = () => {
      const c = counter.current
      const seed = SEED[c.seed % SEED.length]!
      c.seed += 1
      const id = ++c.id
      setRows((prev): Row[] =>
        [{ ...seed, id, status: "queued" as const, at: "now" }, ...prev].slice(0, 7),
      )
      setStep(0)
      const set = (status: Status, after: number) =>
        timers.push(
          setTimeout(
            () =>
              setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r))),
            after,
          ),
        )
      for (let s = 1; s <= TIMELINE.length; s++)
        timers.push(setTimeout(() => setStep(s), s * 380))
      set("sent", 700)
      set(c.seed % 4 === 3 ? "opened" : "delivered", 1900)
      timers.push(
        setTimeout(() => {
          setRows((prev) =>
            prev.map((r, i) => (i === 0 ? r : { ...r, at: bump(r.at) })),
          )
        }, 2600),
      )
    }
    cycle()
    const interval = setInterval(cycle, 3400)
    return () => {
      clearInterval(interval)
      timers.forEach(clearTimeout)
    }
  }, [running])

  const newest = rows[0]

  return (
    <div
      ref={root}
      className="grid h-[600px] grid-cols-[200px_1fr] bg-surface-1 text-[12.5px] max-lg:grid-cols-1 md:h-[640px] lg:grid-cols-[208px_1fr_300px]"
    >
      {/* Sidebar */}
      <aside className="flex flex-col border-r border-line bg-canvas/60 p-3 max-lg:hidden">
        <div className="flex items-center gap-2 rounded-[10px] px-2 py-1.5">
          <span className="grid size-6 place-items-center rounded-[7px] bg-brand text-brand-ink">
            <Mark className="h-[9px] w-auto" />
          </span>
          <span className="font-[540] text-fg">Acme</span>
          <span className="rounded-[5px] bg-white/[0.06] px-1.5 py-px font-mono text-[10px] text-fg-3">
            PRO
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-[9px] px-2.5 py-1.5 text-fg-4 shadow-[inset_0_0_0_1px_var(--line)]">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
            <circle
              cx="7"
              cy="7"
              r="4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="m10.5 10.5 3 3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          Search
          <span className="ml-auto font-mono text-[10px]">⌘K</span>
        </div>
        <nav className="mt-4 flex flex-col gap-px">
          {NAV.map((item) => (
            <span
              key={item.label}
              className={cn(
                "group flex items-center gap-2.5 rounded-[8px] px-2.5 py-[7px]",
                item.active ? "bg-white/[0.06] text-fg" : "text-fg-3",
              )}
            >
              <PixelIcon
                name={item.icon}
                size={13}
                className={item.active ? "text-brand" : ""}
              />
              {item.label}
              {item.count ? (
                <span className="ml-auto font-mono text-[10.5px] text-fg-4">
                  {item.count}
                </span>
              ) : null}
            </span>
          ))}
        </nav>
        <div className="mt-auto flex items-center gap-3 rounded-[10px] p-2.5 shadow-[inset_0_0_0_1px_var(--line)]">
          <UsageRing value={0.42} />
          <div className="flex flex-col leading-tight">
            <span className="text-fg-2">21,480 sent</span>
            <span className="text-[11px] text-fg-4">of 50,000 this month</span>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <h3 className="text-[17px] font-[560] tracking-[-0.02em] text-fg">
              Emails
            </h3>
            <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-delivered">
              <span className="size-1.5 animate-pulse rounded-full bg-delivered" /> LIVE
            </span>
          </div>
          <span className="flex items-center gap-2 rounded-[8px] px-2.5 py-1 font-mono text-[11px] text-fg-3 shadow-[inset_0_0_0_1px_var(--line)]">
            {"</>"} API
          </span>
        </div>
        <div className="flex gap-2 px-6 py-3">
          {["All statuses", "Last 3 days", "acme.co", "API key: production"].map(
            (f, i) => (
              <span
                key={f}
                className={cn(
                  "rounded-[8px] px-2.5 py-1 text-[11.5px] shadow-[inset_0_0_0_1px_var(--line)]",
                  i === 0 ? "text-fg-2" : "text-fg-3",
                  i === 3 && "max-md:hidden",
                )}
              >
                {f}
              </span>
            ),
          )}
        </div>
        <div className="grid grid-cols-[1.2fr_110px_1.6fr_56px] gap-4 border-y border-line bg-white/[0.015] px-6 py-2 font-mono text-[10.5px] tracking-wide text-fg-4 uppercase max-md:grid-cols-[1fr_96px_52px]">
          <span>To</span>
          <span>Status</span>
          <span className="max-md:hidden">Subject</span>
          <span className="text-right">Sent</span>
        </div>
        <ul className="relative flex-1 overflow-hidden">
          <AnimatePresence initial={false}>
            {rows.map((row) => (
              <motion.li
                key={row.id}
                layout
                initial={{
                  opacity: 0,
                  y: -16,
                  backgroundColor: "rgba(242,207,60,0.06)",
                }}
                animate={{ opacity: 1, y: 0, backgroundColor: "rgba(242,207,60,0)" }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 0.55,
                  ease: [0.16, 1, 0.3, 1],
                  backgroundColor: { duration: 1.6 },
                }}
                className="grid grid-cols-[1.2fr_110px_1.6fr_56px] items-center gap-4 border-b border-line-faint px-6 py-[13px] max-md:grid-cols-[1fr_96px_52px]"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.05] text-[10px] text-fg-3 uppercase">
                    {row.to[0]}
                  </span>
                  <span className="truncate text-fg-2">{row.to}</span>
                </span>
                <span>
                  <StatusChip status={row.status} />
                </span>
                <span className="truncate text-fg-2 max-md:hidden">{row.subject}</span>
                <span className="text-right font-mono text-[11px] text-fg-4">
                  {row.at}
                </span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </div>

      {/* Timeline of the newest message */}
      <aside className="flex flex-col border-l border-line bg-canvas/40 p-5 max-lg:hidden">
        <span className="type-label text-fg-4">Latest message</span>
        <p className="mt-3 truncate text-[13.5px] font-[520] text-fg">
          {newest?.subject}
        </p>
        <p className="mt-1 truncate font-mono text-[11px] text-fg-3">to {newest?.to}</p>
        <ol className="relative mt-6 flex flex-col gap-5">
          <span
            aria-hidden
            className="absolute top-2 bottom-2 left-[5px] w-px bg-line"
          />
          <span
            aria-hidden
            className="absolute top-2 left-[5px] w-px bg-brand transition-[height] duration-500 ease-[var(--ease-out-quint)]"
            style={{
              height: `calc(${(Math.min(step, TIMELINE.length) - 1) / (TIMELINE.length - 1)} * (100% - 16px))`,
            }}
          />
          {TIMELINE.map((t, i) => {
            const done = i < step
            return (
              <li key={t.title} className="relative flex gap-3.5 pl-0">
                <span
                  className={cn(
                    "relative mt-[5px] size-[11px] shrink-0 rounded-full transition-[background-color,box-shadow] duration-300",
                    done
                      ? "bg-brand shadow-[0_0_0_4px_rgb(242_207_60/0.14)]"
                      : "bg-surface-4",
                  )}
                />
                <span
                  className={cn(
                    "flex min-w-0 flex-col transition-opacity duration-300",
                    done ? "opacity-100" : "opacity-40",
                  )}
                >
                  <span className="text-[12.5px] text-fg">{t.title}</span>
                  <span className="truncate text-[11.5px] text-fg-3">{t.detail}</span>
                  <span className="mt-0.5 font-mono text-[10px] text-fg-4">
                    {t.mono}
                  </span>
                </span>
              </li>
            )
          })}
        </ol>
        <div className="mt-auto rounded-[10px] p-3 font-mono text-[10.5px] leading-[16px] text-fg-3 shadow-[inset_0_0_0_1px_var(--line)]">
          <span className="text-hue-hook">email.delivered</span> →{" "}
          <span className="text-fg-2">https://acme.co/hooks</span>
          <br />
          <span className="text-delivered">200 OK</span> · signed · 41ms
        </div>
      </aside>
    </div>
  )
}

function StatusChip({ status }: { status: Status }) {
  const chip = CHIP[status]
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center rounded-[6px] px-2 text-[11px] font-[520] transition-colors duration-300",
        chip.className,
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={status}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18 }}
        >
          {chip.label}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

function UsageRing({ value }: { value: number }) {
  const r = 11
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden className="-rotate-90">
      <circle
        cx="14"
        cy="14"
        r={r}
        fill="none"
        stroke="var(--surface-4)"
        strokeWidth="3"
      />
      <circle
        cx="14"
        cy="14"
        r={r}
        fill="none"
        stroke="var(--brand)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${c * value} ${c}`}
      />
    </svg>
  )
}

const bump = (at: string) => {
  if (at === "now") return "1m"
  const n = Number.parseInt(at, 10)
  return Number.isFinite(n) ? `${n + 1}m` : at
}
