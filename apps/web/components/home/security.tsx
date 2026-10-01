"use client"

import { useRef } from "react"
import { IconTile } from "@/components/brand/icon-tile"
import { Eyebrow, Frame, SectionHeader } from "@/components/site/section"
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/gsap"
import type { Hue, IconName } from "@/lib/site"

/*
 * Signed and sealed. Two borrowed moves, both about what DKIM actually is:
 *  - a signature drawn by the scroll (landonorris.com draws Lando's this way),
 *  - the DKIM-Signature header decoding out of noise (Infisical, Offbrand).
 * The facts beside them are the repository's, not marketing's.
 */
const FACTS: { icon: IconName; hue: Hue; title: string; body: string }[] = [
  {
    icon: "key",
    hue: "deliver",
    title: "Sealed bodies",
    body: "Full message bodies are sealed into per-workspace packs, and only leave Postgres once the pack has been read back.",
  },
  {
    icon: "globe",
    hue: "domain",
    title: "Sent from Frankfurt",
    body: "One region, chosen once: eu-central-1. Your mail and its metadata stay in the EU.",
  },
  {
    icon: "shield",
    hue: "hook",
    title: "Header injection refused",
    body: "CR and LF in addresses and header names are rejected by the API contract, then again by the MIME builder.",
  },
  {
    icon: "code",
    hue: "send",
    title: "Keys you can grep",
    body: "i10_live_ and i10_test_ prefixes stand out in logs and secret scanners. Revocation is immediate.",
  },
]

const HEADER = [
  "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;",
  " d=acme.co; s=i10; t=1790784000;",
  " h=from:to:subject:date:message-id;",
  " bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;",
  " b=dzdVyOfAKCdLXdJOc9G2q8LoXSlEniSbav+yuU4zGeeruD00",
  "   lszZVoG4ZHRNiYzR8GMnlQM4KvbMEnVjZYLjgDRXF6HPuqMx",
]

export function Security() {
  const root = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      if (prefersReducedMotion()) return
      const sig = root.current?.querySelector<SVGPathElement>("[data-signature]")
      if (sig) {
        gsap.fromTo(
          sig,
          { drawSVG: "0%" },
          {
            drawSVG: "100%",
            ease: "none",
            scrollTrigger: {
              trigger: sig,
              start: "top 85%",
              end: "bottom 35%",
              scrub: 0.6,
            },
          },
        )
      }
      const lines = gsap.utils.toArray<HTMLElement>("[data-scramble]", root.current)
      lines.forEach((line, i) => {
        const text = line.dataset.scramble ?? ""
        gsap.to(line, {
          duration: 1.2,
          delay: i * 0.12,
          scrambleText: {
            text,
            chars: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
            speed: 0.6,
            revealDelay: 0.2,
          },
          scrollTrigger: {
            trigger: root.current?.querySelector("[data-header]"),
            start: "top 80%",
            once: true,
          },
        })
      })
    },
    { scope: root },
  )

  return (
    <Frame className="py-24 md:py-32" id="security">
      <div ref={root} className="grid gap-16 lg:grid-cols-[1fr_1.1fr] lg:items-center">
        <div>
          <SectionHeader
            eyebrow={<Eyebrow color="var(--hue-deliver)">Security</Eyebrow>}
            title="Every message signed."
            muted="Every body sealed."
            description="DKIM on every send, alignment from the first record, and a storage layer built so the only copy of a message is never the one in flight."
          />
          <ul className="mt-12 grid gap-7 sm:grid-cols-2">
            {FACTS.map((f) => (
              <li data-reveal key={f.title} className="group flex flex-col gap-3">
                <IconTile icon={f.icon} hue={f.hue} />
                <p className="text-[15px] font-[540] text-fg">{f.title}</p>
                <p className="text-[14px] leading-[22px] text-fg-3">{f.body}</p>
              </li>
            ))}
          </ul>
        </div>

        <div
          data-reveal
          className="relative overflow-hidden rounded-[20px] bg-surface-1 p-6 shadow-[inset_0_0_0_1px_var(--line)] md:p-8"
        >
          <div
            aria-hidden
            className="security-lines pointer-events-none absolute inset-0"
          />
          <div className="relative flex items-center justify-between">
            <span className="type-label text-fg-4">Message headers</span>
            <span className="flex items-center gap-2 font-mono text-[11px] text-delivered">
              <span className="size-1.5 rounded-full bg-delivered" /> dkim=pass spf=pass
              dmarc=pass
            </span>
          </div>
          <pre
            data-header
            className="relative mt-6 overflow-hidden font-mono text-[12px] leading-[21px] text-fg-3"
          >
            {HEADER.map((line, i) => (
              <span key={i} className="block whitespace-pre">
                <span
                  data-scramble={line}
                  className={i === 0 ? "text-fg-2" : undefined}
                >
                  {line}
                </span>
              </span>
            ))}
          </pre>
          <div className="relative mt-10 flex items-end justify-between gap-6 border-t border-line pt-6">
            <div>
              <p className="type-label text-fg-4">Signed by</p>
              <p className="mt-2 text-[14px] text-fg-2">
                acme.co <span className="text-fg-4">via</span> i10
              </p>
            </div>
            <svg
              viewBox="0 0 300 110"
              className="h-[92px] w-auto overflow-visible"
              aria-hidden
            >
              <path
                data-signature
                d="M14 86c10-2 18-14 22-30 3-12 2-22-2-18-5 5-4 34 2 44 4 7 11 4 16-4 7-12 9-30 16-38 3-4 6-2 5 3-2 14-6 44-2 54 3 6 9 1 12-6 8-20 14-48 32-54 16-5 22 12 20 28-2 20-18 36-30 32-12-4-10-26 2-38 14-14 40-10 52 4 14 16 8 40 30 42 20 2 40-10 58-22M44 20c1 0 2 1 1 2"
                fill="none"
                stroke="var(--brand)"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
      </div>
    </Frame>
  )
}
