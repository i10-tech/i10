"use client"

import Link from "next/link"
import { useRef, useState } from "react"
import { cn } from "cn"
import { IconTile } from "@/components/brand/icon-tile"
import { LineGraphic, type GraphicVariant } from "@/components/fx/line-graphic"
import { Arrow } from "@/components/ui/button-link"
import { Badge } from "@/components/ui/badge"
import { gsap, ScrollTrigger, useGSAP } from "@/lib/gsap"
import type { Badge as BadgeKind, Hue, IconName } from "@/lib/site"

/*
 * The product, one panel at a time, scrolled sideways (GSAP's own homepage
 * does this better than anyone). The section pins, vertical scroll drives the
 * track horizontally, and an index at the top says where you are.
 *
 * Only on wide screens: below 1024px the panels simply stack. Horizontal
 * scroll on a phone fights the thumb and wins nothing.
 *
 * The entry is drakko's lookbook: the sideways travel starts BEFORE the pin.
 * While the section is still rising into view, an outer wrapper slides the
 * first LEAD of the distance (the track starts LEAD further right to pay for
 * it), so by the time the pin catches the cards are already moving and the
 * hand-over from vertical to horizontal has no jolt. The pinned phase then
 * covers the rest, and the track carries the same inset on both ends, so the
 * first card starts and the last card stops on the page column.
 */
const LEAD = 0.3 // of the viewport width
interface Panel {
  id: string
  label: string
  title: string
  body: string
  points: string[]
  hue: Hue
  icon: IconName
  graphic: GraphicVariant
  href: string
  badge?: BadgeKind
}

const PANELS: Panel[] = [
  {
    id: "sending",
    label: "Email API",
    title: "Send one, or a thousand.",
    body: "Transactional email over a Resend-compatible REST API, with SDKs that stay out of your bundle.",
    points: [
      "Batch sends",
      "Idempotency keys",
      "Inline images by Content-ID",
      "Typed, retryable errors",
    ],
    hue: "send",
    icon: "send",
    graphic: "rings",
    href: "/product/email-api",
  },
  {
    id: "mailboxes",
    label: "Mailboxes",
    title: "Real mailboxes on your domain.",
    body: "Inboxes for the people behind the product, on the same domain you send from. One address, one password.",
    points: [
      "IMAP, JMAP and SMTP",
      "Webmail included",
      "Aliases and groups",
      "Works in every mail app",
    ],
    hue: "mail",
    icon: "mailbox",
    graphic: "stack",
    href: "/product/mailboxes",
  },
  {
    id: "templates",
    label: "Templates",
    title: "Templates that ship like code.",
    body: "Write React Email, design in a visual editor, or connect a repository and let a push publish the next version.",
    points: ["React Email", "Visual editor", "Push to publish", "Versions and diffs"],
    hue: "template",
    icon: "template",
    graphic: "branch",
    href: "/product/templates",
    badge: "new",
  },
  {
    id: "webhooks",
    label: "Webhooks",
    title: "Every event, signed.",
    body: "Delivered, opened, clicked, bounced and complained, signed to the Standard Webhooks spec and retried until you answer.",
    points: [
      "Standard Webhooks signatures",
      "Automatic retries",
      "Replay from the console",
      "Per-domain tracking",
    ],
    hue: "hook",
    icon: "webhook",
    graphic: "burst",
    href: "/product/webhooks",
  },
  {
    id: "deliverability",
    label: "Deliverability",
    title: "Built to land.",
    body: "Aligned SPF and DKIM from the first send, per-workspace suppressions, and reputation watched on every domain.",
    points: [
      "SPF and DKIM alignment",
      "Suppression lists",
      "Complaint guard",
      "Reputation tracking",
    ],
    hue: "deliver",
    icon: "shield",
    graphic: "gauge",
    href: "/product/deliverability",
  },
  {
    id: "broadcasts",
    label: "Broadcasts",
    title: "Broadcasts, when you need them.",
    body: "Contacts, segments and topics for the product updates and newsletters that sit next to your transactional mail.",
    points: [
      "Contacts and segments",
      "Topics and unsubscribes",
      "One-click list headers",
      "Same sending domain",
    ],
    hue: "mail",
    icon: "broadcast",
    graphic: "field",
    href: "/product/broadcasts",
    badge: "beta",
  },
]

export function ProductRail() {
  const section = useRef<HTMLElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const lead = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLSpanElement>(null)
  const [active, setActive] = useState(0)

  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add("(min-width: 1024px) and (prefers-reduced-motion: no-preference)", () => {
        const el = track.current
        if (!el || !lead.current) return
        const leadIn = () => window.innerWidth * LEAD
        // What is left after the lead-in: the track's full overflow (its
        // padding included, which is what lands the last card on the
        // column) minus the part the wrapper already travelled.
        const distance = () => el.scrollWidth - window.innerWidth - leadIn()

        // Panel graphics drift a little against the track: depth. Worked out
        // from each panel's place on screen on every rendered frame of either
        // phase, rather than with `containerAnimation` triggers: those hang
        // off the rail tween's ScrollTrigger and read its `.end`, and any
        // refresh that ran while it was being torn down (hot reload, crossing
        // the breakpoint) threw "Cannot read properties of undefined
        // (reading 'end')".
        const drifts = gsap.utils
          .toArray<HTMLElement>("[data-parallax]", el)
          .map((node) => ({
            box: node.parentElement!,
            set: gsap.quickSetter(node, "xPercent"),
          }))
        const drift = () => {
          const vw = window.innerWidth
          for (const d of drifts) {
            const r = d.box.getBoundingClientRect()
            // 0 as the panel's left edge enters on the right, 1 as its right
            // edge leaves on the left.
            const t = gsap.utils.clamp(0, 1, (vw - r.left) / (vw + r.width))
            d.set(12 - 24 * t)
          }
        }

        // Phase 1, before the pin: scrubbed by the section rising from the
        // bottom of the screen to the top.
        gsap.fromTo(
          lead.current,
          { x: 0 },
          {
            x: () => -leadIn(),
            ease: "none",
            onUpdate: drift,
            scrollTrigger: {
              trigger: section.current,
              start: "top bottom",
              end: "top top",
              scrub: 0.8,
              invalidateOnRefresh: true,
            },
          },
        )

        // Phase 2, pinned: the rest of the way.
        let shown = 0
        gsap.to(el, {
          x: () => -distance(),
          ease: "none",
          onUpdate: drift,
          scrollTrigger: {
            trigger: section.current,
            start: "top top",
            end: () => `+=${distance()}`,
            pin: true,
            scrub: 0.8,
            invalidateOnRefresh: true,
            anticipatePin: 1,
            onUpdate: (self) => {
              if (bar.current) bar.current.style.transform = `scaleX(${self.progress})`
              // Re-render only when the index actually changes, not on
              // every scroll event.
              const next = Math.min(
                PANELS.length - 1,
                Math.round(self.progress * (PANELS.length - 1)),
              )
              if (next !== shown) {
                shown = next
                setActive(next)
              }
            },
          },
        })
        // Leaving the breakpoint unpins the rail, so everything below has to
        // re-measure. ⚠ ONE FRAME LATER, never inside this cleanup: it runs
        // while matchMedia is still reverting, and a refresh then walks
        // half-removed triggers ("Cannot read properties of undefined
        // (reading 'end')", seen on hot reload).
        return () => requestAnimationFrame(() => ScrollTrigger.refresh())
      })
      return () => mm.revert()
    },
    { scope: section },
  )

  return (
    <section
      ref={section}
      data-nav-tone="dark"
      className="relative overflow-hidden border-t border-line lg:h-screen"
    >
      <div className="container-site flex items-end justify-between gap-8 pt-24 lg:pt-[calc(var(--nav-h)+3.5rem)]">
        <div>
          <p className="type-label text-fg-4">The platform</p>
          <h2 className="type-display-m mt-4 max-w-[18ch]">
            Everything email needs.{" "}
            <span className="text-fg-3">Nothing it doesn&apos;t.</span>
          </h2>
        </div>
        <div className="hidden min-w-[260px] flex-col gap-3 lg:flex">
          <div className="flex justify-between font-mono text-[11px] text-fg-4">
            <span className="text-fg-2">
              {String(active + 1).padStart(2, "0")} {PANELS[active]?.label}
            </span>
            <span>{String(PANELS.length).padStart(2, "0")}</span>
          </div>
          <span className="relative h-px w-full bg-line">
            <span
              ref={bar}
              className="absolute inset-0 origin-left scale-x-0 bg-brand"
            />
          </span>
        </div>
      </div>

      <div ref={lead} className="lg:w-max">
        <div
          ref={track}
          className="mt-12 flex flex-col gap-4 px-[var(--gutter)] pb-24 lg:mt-14 lg:w-max lg:flex-row lg:gap-5 lg:pr-[max(var(--gutter),calc((100vw-var(--container))/2))] lg:pb-0 lg:pl-[calc(max(var(--gutter),calc((100vw-var(--container))/2))+30vw)]"
        >
          {PANELS.map((panel, i) => (
            <article
              key={panel.id}
              className={cn(
                "rail-panel group relative grid overflow-hidden rounded-[22px] bg-surface-1 lg:h-[min(62vh,540px)] lg:w-[min(78vw,920px)] lg:grid-cols-[1fr_1.05fr]",
              )}
            >
              <div className="relative z-10 flex flex-col p-7 md:p-9">
                <div className="flex items-center gap-3">
                  <IconTile icon={panel.icon} hue={panel.hue} />
                  <span className="font-mono text-[11px] text-fg-4">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-[13px] text-fg-2">{panel.label}</span>
                  {panel.badge ? <Badge kind={panel.badge} /> : null}
                </div>
                <h3 className="type-display-s mt-8 max-w-[14ch]">{panel.title}</h3>
                <p className="type-body mt-4 max-w-[34ch]">{panel.body}</p>
                <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-2.5">
                  {panel.points.map((pt) => (
                    <li
                      key={pt}
                      className="flex items-center gap-2 text-[13px] text-fg-2"
                    >
                      <span
                        className="size-1 shrink-0 rounded-full"
                        style={{ background: `var(--hue-${panel.hue})` }}
                      />
                      {pt}
                    </li>
                  ))}
                </ul>
                <Link
                  href={panel.href}
                  className="group/btn mt-auto inline-flex w-fit items-center gap-1.5 pt-8 text-[13px] text-fg-2 transition-colors hover:text-fg"
                >
                  Explore {panel.label} <Arrow />
                </Link>
              </div>
              <div className="relative min-h-[260px] border-line max-lg:border-t lg:border-l">
                <div aria-hidden className="rail-grid absolute inset-0" />
                <div data-parallax className="absolute inset-0">
                  <LineGraphic
                    variant={panel.graphic}
                    accent={`var(--hue-${panel.hue})`}
                  />
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
