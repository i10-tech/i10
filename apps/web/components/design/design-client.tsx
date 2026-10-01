"use client"

import { motion } from "motion/react"
import { useEffect, useRef, useState } from "react"
import { cn } from "cn"

/*
 * The interactive parts of /design: the section bar that follows the reader,
 * a type scale that reports its own sizes at the current viewport, swatches
 * that copy their token, and a motion bench that races the site's curves.
 */

export const DESIGN_SECTIONS = [
  { id: "colour", title: "Colour" },
  { id: "type", title: "Type" },
  { id: "shape", title: "Shape" },
  { id: "motion", title: "Motion" },
  { id: "icons", title: "Icons" },
  { id: "components", title: "Components" },
] as const

/*
 * Sticky under the site nav, with one highlight that slides to the section in
 * view - the same move as the main nav, so the page teaches its own pattern.
 */
export function DesignNav() {
  const [active, setActive] = useState<string>(DESIGN_SECTIONS[0].id)

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id)
      },
      { rootMargin: "-45% 0px -50% 0px" },
    )
    DESIGN_SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id)
      if (el) io.observe(el)
    })
    return () => io.disconnect()
  }, [])

  return (
    <div className="sticky top-[calc(var(--nav-h)+0.75rem)] z-30 flex justify-center px-4">
      <nav
        aria-label="Design system sections"
        className="flex max-w-full gap-0.5 overflow-x-auto rounded-full bg-surface-1/80 p-1 shadow-[inset_0_0_0_1px_var(--line),0_12px_32px_-12px_rgb(0_0_0/0.8)] backdrop-blur-xl [scrollbar-width:none]"
      >
        {DESIGN_SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            aria-current={active === s.id ? "location" : undefined}
            className={cn(
              "relative shrink-0 rounded-full px-3.5 py-1.5 text-[13px] transition-colors duration-200",
              active === s.id ? "text-fg" : "text-fg-3 hover:text-fg-2",
            )}
          >
            {active === s.id ? (
              <motion.span
                layoutId="design-nav"
                className="absolute inset-0 rounded-full bg-surface-4 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]"
                transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              />
            ) : null}
            <span className="relative">{s.title}</span>
          </a>
        ))}
      </nav>
    </div>
  )
}

/* A swatch that copies `var(--token)` and says so where the click landed. */
export function Swatch({
  token,
  value,
  dark,
}: {
  token: string
  value: string
  dark?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(`var(${token})`)
          setCopied(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1400)
        } catch {
          /* The token is printed on the swatch; it can be selected by hand. */
        }
      }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-[14px] bg-surface-1 text-left shadow-[inset_0_0_0_1px_var(--line)] transition-shadow duration-300 hover:shadow-[inset_0_0_0_1px_var(--line-strong)]"
    >
      <span
        className="relative m-1 block h-16 rounded-[10px] shadow-[inset_0_0_0_1px_var(--line)]"
        style={{ background: `var(${token})` }}
      >
        <span
          className={cn(
            "absolute inset-0 grid place-items-center font-mono text-[10.5px] transition-opacity duration-200",
            dark ? "text-fg" : "text-brand-ink",
            copied ? "opacity-100" : "opacity-0",
          )}
        >
          Copied
        </span>
      </span>
      <span className="px-3 pt-1.5 pb-3">
        <span className="block font-mono text-[11.5px] text-fg">{token}</span>
        <span className="mt-0.5 block truncate font-mono text-[10.5px] text-fg-4">
          {value}
        </span>
      </span>
    </button>
  )
}

const SCALE = [
  { cls: "type-display-xl", name: "Display XL", sample: "Email for developers." },
  { cls: "type-display-l", name: "Display L", sample: "Mail delivery failed." },
  { cls: "type-display-m", name: "Display M", sample: "One record to start." },
  { cls: "type-display-s", name: "Display S", sample: "Questions, answered." },
  { cls: "type-title", name: "Title", sample: "GitHub-connected templates" },
  { cls: "type-lead", name: "Lead", sample: "Start free and pay for what you send." },
  {
    cls: "type-body",
    name: "Body",
    sample:
      "Replays with the same key return the first result instead of sending again.",
  },
  { cls: "type-label", name: "Label", sample: "Deliverable addresses" },
]

/*
 * Every step of the scale, with its size and leading read back from the
 * browser. The display sizes are fluid clamps, so the numbers change as the
 * window does - which is the point of printing them.
 */
export function TypeScale() {
  const refs = useRef<(HTMLParagraphElement | null)[]>([])
  const [metrics, setMetrics] = useState<string[]>([])

  useEffect(() => {
    const measure = () =>
      setMetrics(
        refs.current.map((el) => {
          if (!el) return ""
          const cs = getComputedStyle(el)
          const size = parseFloat(cs.fontSize)
          const lh = cs.lineHeight === "normal" ? size * 1.2 : parseFloat(cs.lineHeight)
          const track = parseFloat(cs.letterSpacing) / size
          return `${Math.round(size)}/${Math.round(lh)} · ${cs.fontWeight} · ${Number.isFinite(track) ? track.toFixed(3) : "0"}em`
        }),
      )
    measure()
    document.fonts?.ready.then(measure)
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [])

  return (
    <div className="flex flex-col">
      {SCALE.map((s, i) => (
        <div
          key={s.cls}
          className="grid items-baseline gap-3 border-t border-line py-7 md:grid-cols-[200px_1fr] md:gap-10"
        >
          <div className="flex flex-col gap-1">
            <span className="text-[13px] font-[540] text-fg">{s.name}</span>
            <span className="font-mono text-[11px] text-fg-4">.{s.cls}</span>
            <span className="font-mono text-[11px] text-fg-3 tabular-nums">
              {metrics[i] || " "}
            </span>
          </div>
          <p
            ref={(el) => {
              refs.current[i] = el
            }}
            className={cn(
              s.cls,
              "min-w-0 text-fg",
              s.cls === "type-label" && "text-fg-3",
            )}
          >
            {s.sample}
          </p>
        </div>
      ))}
    </div>
  )
}

const EASES = [
  {
    name: "Out expo",
    token: "--ease-out-expo",
    curve: [0.16, 1, 0.3, 1],
    use: "Reveals, panels, anything arriving",
  },
  {
    name: "Out quint",
    token: "--ease-out-quint",
    curve: [0.22, 1, 0.36, 1],
    use: "Hover lifts and small moves",
  },
  {
    name: "In-out quart",
    token: "--ease-in-out-quart",
    curve: [0.77, 0, 0.175, 1],
    use: "Things that leave and come back",
  },
  {
    name: "Back",
    token: "--ease-back",
    curve: [0.175, 0.885, 0.32, 1.1],
    use: "Stamps and toggles, sparingly",
  },
] as const

/*
 * The curves, drawn and raced. Press play and four dots cross the same track
 * in the same time on each curve; the difference is the whole argument for
 * picking one on purpose.
 */
export function MotionBench() {
  const [run, setRun] = useState(0)
  const [at, setAt] = useState(false)

  useEffect(() => {
    if (!run) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restart from the left edge, then let the transition carry the dots across
    setAt(false)
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setAt(true)))
    return () => cancelAnimationFrame(frame)
  }, [run])

  return (
    <div className="rounded-[20px] bg-surface-1 p-6 shadow-[inset_0_0_0_1px_var(--line)] md:p-8">
      <div className="flex items-center justify-between">
        <span className="type-label text-fg-4">900ms each</span>
        <button
          type="button"
          onClick={() => setRun((n) => n + 1)}
          className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-full bg-surface-3 px-3.5 text-[13px] text-fg shadow-[inset_0_0_0_1px_var(--line-strong)] transition-colors hover:bg-surface-4"
        >
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
            <path
              d="M3 1.8v8.4a.6.6 0 0 0 .9.5l6.6-4.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5Z"
              fill="currentColor"
            />
          </svg>
          {run ? "Replay" : "Play"}
        </button>
      </div>
      <div className="mt-8 flex flex-col gap-6">
        {EASES.map((e) => {
          const [x1, y1, x2, y2] = e.curve
          return (
            <div
              key={e.token}
              className="grid items-center gap-4 sm:grid-cols-[150px_64px_1fr] sm:gap-6"
            >
              <div>
                <p className="text-[13.5px] font-[540] text-fg">{e.name}</p>
                <p className="mt-0.5 text-[12px] leading-[18px] text-fg-3">{e.use}</p>
              </div>
              <svg
                viewBox="-4 -14 68 78"
                className="h-16 w-16 max-sm:hidden"
                aria-hidden
              >
                <rect
                  x="0"
                  y="0"
                  width="60"
                  height="60"
                  fill="none"
                  stroke="var(--line)"
                />
                <path
                  d={`M0 60C${x1 * 60} ${60 - y1 * 60} ${x2 * 60} ${60 - y2 * 60} 60 0`}
                  fill="none"
                  stroke="var(--brand)"
                  strokeWidth="1.5"
                />
              </svg>
              {/* The track is a size container so the dot can travel its width
                  on transform alone (100cqw), never on `left`. */}
              <div className="relative h-7 rounded-full bg-white/[0.03] shadow-[inset_0_0_0_1px_var(--line-faint)] [container-type:inline-size]">
                <span
                  className="absolute top-1/2 left-1 size-5 -translate-y-1/2 rounded-full bg-fg shadow-[0_0_20px_color-mix(in_oklch,var(--brand)_40%,transparent)]"
                  style={{
                    transform: at
                      ? "translateX(calc(100cqw - 1.75rem))"
                      : "translateX(0)",
                    transition: at
                      ? `transform 900ms cubic-bezier(${e.curve.join(",")})`
                      : "none",
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
