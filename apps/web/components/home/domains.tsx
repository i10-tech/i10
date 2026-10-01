"use client"

import { useEffect, useRef, useState } from "react"
import { cn } from "cn"
import { BrandIcon, type BrandName } from "@/components/brand/brand-icon"
import { Eyebrow, Frame, SectionHeader } from "@/components/site/section"
import { ButtonLink } from "@/components/ui/button-link"
import { prefersReducedMotion } from "@/lib/gsap"
import { hosts } from "@/lib/site"

/*
 * WorkOS's toggle drum, with i10's own records: the DNS that onboarding asks
 * for, in the order it asks. Each step the drum turns one tile; the tile
 * arriving at the centre checks and flips on, the ones above it are verified,
 * the ones below are still to come.
 *
 * Every record here is one the docs actually give (apps/docs dns.mdx).
 */
const RECORDS = [
  {
    name: "DKIM",
    host: "i10._domainkey",
    type: "TXT",
    value: "p=MIIBIjANBgkqh…",
    note: "Enough to start sending",
  },
  {
    name: "Return path",
    host: "send",
    type: "MX",
    value: "10 feedback-smtp.eu-central-1…",
    note: "Bounces come home",
  },
  {
    name: "SPF",
    host: "send",
    type: "TXT",
    value: "v=spf1 include:_spf.i10.tech ~all",
    note: "Envelope on your domain",
  },
  {
    name: "DMARC",
    host: "_dmarc",
    type: "TXT",
    value: "v=DMARC1; p=quarantine",
    note: "Passes on alignment",
  },
  {
    name: "Mailboxes",
    host: "@",
    type: "MX",
    value: "10 mail.i10.tech",
    note: "Real inboxes, same domain",
  },
]

const PROVIDERS: BrandName[] = [
  "cloudflare",
  "godaddy",
  "namecheap",
  "porkbun",
  "hetzner",
  "ovh",
  "ionos",
  "gandi",
]

// The drum shows the list twice over so the turn never reveals an empty slot.
const TILES = [...RECORDS, ...RECORDS]

export function Domains() {
  return (
    <Frame className="py-24 md:py-32" id="domains">
      <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.05fr]">
        <div>
          <SectionHeader
            eyebrow={<Eyebrow color="var(--hue-domain)">Domains</Eyebrow>}
            title="One record to start."
            muted="Two more to own it."
            description="The DKIM record alone gets you sending in about two minutes, fully aligned. Add the return path and SPF before volume matters, and the envelope is yours too."
          />
          <div data-reveal className="mt-9 flex flex-wrap items-center gap-3">
            <ButtonLink href={`${hosts.docs}/dns`} variant="secondary" arrow>
              <BrandIcon name="cloudflare" size={15} colored /> Connect Cloudflare
            </ButtonLink>
            <ButtonLink href={`${hosts.docs}/dns`} variant="ghost" arrow>
              How the records work
            </ButtonLink>
          </div>
          <div data-reveal className="mt-10">
            <p className="type-label text-fg-4">Guided setup for your registrar</p>
            <ul className="mt-4 grid w-fit grid-cols-4 gap-2 sm:flex sm:flex-wrap">
              {PROVIDERS.map((p) => (
                <li
                  key={p}
                  className="grid size-10 place-items-center rounded-[11px] text-fg-3 shadow-[inset_0_0_0_1px_var(--line)] transition-[color,background-color] duration-200 hover:bg-white/[0.04] hover:text-fg"
                >
                  <BrandIcon name={p} size={17} />
                </li>
              ))}
            </ul>
          </div>
        </div>
        <Drum />
      </div>
    </Frame>
  )
}

function Drum() {
  const [active, setActive] = useState(2)
  const [settled, setSettled] = useState(true)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (prefersReducedMotion()) return
    let visible = false
    const io = new IntersectionObserver(
      ([e]) => (visible = Boolean(e?.isIntersecting)),
      { threshold: 0.3 },
    )
    if (root.current) io.observe(root.current)
    const timers: ReturnType<typeof setTimeout>[] = []
    const id = setInterval(() => {
      if (!visible) return
      setSettled(false)
      setActive((a) => (a + 1) % TILES.length)
      timers.push(setTimeout(() => setSettled(true), 700))
    }, 1900)
    return () => {
      clearInterval(id)
      timers.forEach(clearTimeout)
      io.disconnect()
    }
  }, [])

  return (
    <div
      ref={root}
      data-reveal
      className="relative h-[460px] overflow-hidden rounded-[20px]"
    >
      <div aria-hidden className="drum-stripes pointer-events-none absolute inset-0" />
      {/* The arc's sideways step is a variable so phones get a shallower arc:
          at 10px a step, the lead tile touched the edge of a 375px screen. */}
      <div className="absolute inset-0 [--drum-x:5px] md:[--drum-x:10px]">
        {TILES.map((record, i) => {
          let rel = i - active
          if (rel > TILES.length / 2) rel -= TILES.length
          if (rel < -TILES.length / 2) rel += TILES.length
          const dist = Math.abs(rel)
          const center = rel === 0
          const on = rel < 0 || (center && settled)
          return (
            <div
              key={i}
              aria-hidden={dist > 2}
              className="absolute top-1/2 left-1/2 w-[min(100%-4rem,400px)] transition-[transform,opacity,filter] duration-700 ease-[var(--ease-out-expo)] md:w-[min(100%-2rem,400px)]"
              style={{
                transform: `translate3d(calc(-50% + ${center ? -1.8 : dist} * var(--drum-x)), calc(-50% + ${rel * 76}px), 0) scale(${center ? 1.04 : 1 - dist * 0.05})`,
                opacity: dist > 3 ? 0 : center ? 1 : 0.62 - dist * 0.14,
                filter: center ? "none" : `blur(${Math.max(0, dist - 1) * 0.8}px)`,
                zIndex: 10 - dist,
              }}
            >
              <div
                className={cn(
                  "flex items-center gap-4 rounded-[16px] px-4 py-3.5 transition-[background-color,box-shadow] duration-500",
                  center
                    ? "bg-surface-3 shadow-[inset_0_0_0_1px_var(--line-strong),0_24px_50px_-20px_rgb(0_0_0/0.9)]"
                    : "bg-surface-2 shadow-[inset_0_0_0_1px_var(--line)]",
                )}
              >
                <Toggle on={on} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-[540] text-fg">
                      {record.name}
                    </span>
                    <span className="rounded-[5px] bg-white/[0.05] px-1.5 py-px font-mono text-[10px] text-fg-3">
                      {record.type}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-fg-3">
                    <span className="text-fg-2">{record.host}</span> · {record.value}
                  </p>
                </div>
                <Status
                  state={
                    rel < 0 || (center && settled)
                      ? "verified"
                      : center
                        ? "checking"
                        : "pending"
                  }
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-300",
        on ? "bg-delivered/90" : "bg-surface-4 shadow-[inset_0_0_0_1px_var(--line)]",
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] left-[3px] size-4 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.4)] transition-transform duration-300 ease-[var(--ease-back)]",
          on && "translate-x-4",
        )}
      />
    </span>
  )
}

function Status({ state }: { state: "verified" | "checking" | "pending" }) {
  const map = {
    verified: {
      label: "Verified",
      cls: "bg-delivered/12 text-delivered shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--state-delivered)_28%,transparent)]",
    },
    checking: {
      label: "Checking",
      cls: "bg-complained/12 text-complained shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--state-complained)_28%,transparent)]",
    },
    pending: {
      label: "Pending",
      cls: "bg-white/[0.04] text-fg-3 shadow-[inset_0_0_0_1px_var(--line)]",
    },
  }[state]
  return (
    <span
      className={cn(
        "grid h-6 shrink-0 items-center rounded-[7px] px-2 text-[11px] font-[520] transition-colors duration-300",
        map.cls,
      )}
    >
      {/* All three labels share one cell, so the chip keeps its width. */}
      {(["Verified", "Checking", "Pending"] as const).map((l) => (
        <span
          key={l}
          className={cn(
            "col-start-1 row-start-1 text-center transition-opacity duration-200",
            l === map.label ? "opacity-100" : "opacity-0",
          )}
        >
          {l}
        </span>
      ))}
    </span>
  )
}
