"use client"

import dynamic from "next/dynamic"
import Link from "next/link"
import { Mark } from "@/components/brand/mark"
import { SplitReveal } from "@/components/motion/split-reveal"
import { Arrow, ButtonLink } from "@/components/ui/button-link"
import { CopyButton } from "@/components/ui/copy-button"
import { hosts } from "@/lib/site"

/*
 * The 3D mark loads after the page is interactive, never on the server. Until
 * it arrives the same glyph sits in its place as flat ink at low opacity, so
 * the hero's composition is complete from the first paint and the canvas fades
 * in over something rather than into a hole.
 */
const HeroMarkScene = dynamic(() => import("@/components/three/hero-mark-scene"), {
  ssr: false,
  loading: () => (
    <div className="grid size-full place-items-center">
      <Mark className="h-[34%] w-auto text-white/[0.04]" />
    </div>
  ),
})

export function Hero() {
  return (
    <section
      data-nav-tone="dark"
      className="relative overflow-hidden pt-[calc(var(--nav-h)+5.5rem)] pb-20 md:pb-28"
    >
      <div aria-hidden className="hero-grid pointer-events-none absolute inset-0" />
      <div aria-hidden className="hero-glow pointer-events-none absolute" />

      <div className="container-site relative grid items-center gap-10 lg:min-h-[calc(100svh-var(--nav-h)-5.5rem)] lg:grid-cols-[1.1fr_0.9fr]">
        <div className="relative z-10 flex flex-col items-start">
          <Link
            href="/changelog"
            data-reveal
            className="group/btn mb-8 inline-flex h-8 items-center gap-2.5 rounded-full pr-3 pl-[9px] text-[12.5px] text-fg-2 shadow-[inset_0_0_0_1px_var(--line-strong)] transition-colors hover:text-fg"
          >
            <span className="flex h-5 items-center rounded-full bg-brand px-2 font-mono text-[10px] leading-none font-semibold tracking-[0.08em] text-brand-ink uppercase">
              New
            </span>
            Templates that publish on git push
            <Arrow className="text-fg-3" />
          </Link>

          <SplitReveal
            as="h1"
            mode="scatter"
            onScroll={false}
            delay={0.15}
            className="type-display-xl"
          >
            Email for developers. <br className="max-sm:hidden" />
            <span className="text-fg-3">Mailboxes for</span>{" "}
            <span className="type-accent text-fg">everyone</span>{" "}
            <span className="text-fg-3">else.</span>
          </SplitReveal>

          <p
            data-reveal
            data-reveal-delay="0.35"
            className="type-lead mt-7 max-w-[34rem]"
          >
            A Resend-compatible API, real mailboxes on your own domain, and one DNS
            record to start sending.{" "}
            <span className="text-fg">Keep your code, change one import.</span>
          </p>

          <div
            data-reveal
            data-reveal-delay="0.45"
            className="mt-9 flex flex-wrap items-center gap-3"
          >
            <ButtonLink href={hosts.signIn} size="lg" arrow>
              Start sending free
            </ButtonLink>
            <ButtonLink href={hosts.docs} size="lg" variant="secondary">
              Read the docs
            </ButtonLink>
          </div>

          <div
            data-reveal
            data-reveal-delay="0.55"
            className="mt-6 flex items-center gap-1 rounded-[10px] py-1 pr-1 pl-3 font-mono text-[12.5px] text-fg-2 shadow-[inset_0_0_0_1px_var(--line)]"
          >
            <span className="text-fg-4">$</span>
            <span className="ml-2">bun add @i10/node</span>
            <CopyButton value="bun add @i10/node" className="ml-3" />
          </div>
        </div>

        <div
          data-reveal="fade"
          data-reveal-delay="0.2"
          className="relative -mx-[var(--gutter)] h-[440px] sm:h-[540px] lg:-mr-[5vw] lg:ml-[-12vw] lg:h-[760px]"
        >
          <HeroMarkScene />
          <HeroOrbit />
        </div>
      </div>

      {/* The first block fills the first screen (min-height above), so the
          stats always start below the fold: revealed, they never peek in
          cut off at the bottom of the opening view. */}
      <div className="container-site relative mt-16 md:mt-20">
        <dl
          data-reveal
          className="grid grid-cols-2 gap-px overflow-hidden rounded-[14px] bg-line md:grid-cols-4"
        >
          {[
            ["1", "DNS record to start"],
            ["~2 min", "to your first send"],
            ["0", "runtime dependencies"],
            ["EU", "sent from Frankfurt"],
          ].map(([value, label]) => (
            <div key={label} className="flex flex-col gap-1 bg-canvas px-5 py-4">
              <dt className="order-2 text-[12.5px] text-fg-3">{label}</dt>
              <dd className="font-display text-[22px] leading-7 font-[560] tracking-[-0.03em] text-fg [font-variation-settings:'opsz'_32]">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

/*
 * A postmark ring around the mark: text set on a circle, turning slowly. The
 * cancellation stamp on an envelope is the oldest proof of delivery there is.
 */
function HeroOrbit() {
  const text = "SIGNED · SEALED · DELIVERED · EU-CENTRAL-1 · DKIM · SPF · DMARC · "
  return (
    <svg
      aria-hidden
      viewBox="0 0 400 400"
      className="hero-orbit pointer-events-none absolute top-1/2 left-1/2 w-[min(92%,600px)] -translate-x-1/2 lg:w-[min(96%,660px)] -translate-y-1/2"
    >
      <defs>
        <path
          id="orbit-path"
          d="M200 200m-172 0a172 172 0 1 1 344 0a172 172 0 1 1-344 0"
        />
      </defs>
      <circle
        cx="200"
        cy="200"
        r="190"
        fill="none"
        stroke="var(--line)"
        strokeDasharray="1 5"
      />
      <circle cx="200" cy="200" r="150" fill="none" stroke="var(--line-faint)" />
      <text className="fill-fg-4 font-mono text-[9.5px] tracking-[0.32em]">
        <textPath href="#orbit-path">{text + text}</textPath>
      </text>
    </svg>
  )
}
