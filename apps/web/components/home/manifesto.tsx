"use client"

import { useRef, type ReactNode } from "react"
import { IconTile } from "@/components/brand/icon-tile"
import { splitWords } from "@/components/motion/split-reveal"
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/gsap"
import type { Hue, IconName } from "@/lib/site"

/*
 * A paragraph that lights up as you read it (GSAP's homepage, Dub's): every
 * word starts in the faint ramp and brightens as the scroll passes it, and a
 * few nouns carry their product's icon tile inline.
 */
function Inline({ icon, hue }: { icon: IconName; hue: Hue }) {
  return (
    <span className="group mx-[0.12em] inline-flex translate-y-[-0.08em] align-middle">
      <IconTile icon={icon} hue={hue} size="md" className="size-[0.86em] rounded-[0.22em] [&_svg]:size-[0.46em]" />
    </span>
  )
}

const TEXT: ReactNode = (
  <>
    Email is the one API every product needs <Inline icon="send" hue="send" /> and nobody wants to own. i10 signs every message{" "}
    <Inline icon="shield" hue="deliver" />, sends it from Frankfurt <Inline icon="globe" hue="domain" />, and lands it in the inbox under
    a domain that is actually yours. It speaks Resend <Inline icon="code" hue="template" />, so switching is one line. And when your
    team wants real mailboxes <Inline icon="mailbox" hue="mail" />, they are already there.
  </>
)

export function Manifesto() {
  const root = useRef<HTMLParagraphElement>(null)

  useGSAP(
    () => {
      const words = gsap.utils.toArray<HTMLElement>(".sw-i", root.current)
      const tiles = gsap.utils.toArray<HTMLElement>(".icon-tile", root.current)
      if (prefersReducedMotion()) return
      gsap.set(words, { color: "var(--fg-4)" })
      gsap.set(tiles, { opacity: 0.25, scale: 0.8 })
      const tl = gsap.timeline({
        scrollTrigger: { trigger: root.current, start: "top 78%", end: "bottom 42%", scrub: 0.5 },
      })
      tl.to(words, { color: "var(--fg)", stagger: 0.1, ease: "none", duration: 0.4 }, 0)
      tiles.forEach((tile) => {
        const index = words.findIndex((w) => tile.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING)
        tl.to(tile, { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2.4)" }, Math.max(0, index) * 0.1)
      })
    },
    { scope: root },
  )

  return (
    <section data-nav-tone="dark" className="relative py-28 md:py-40">
      <div className="container-site">
        <p ref={root} className="type-display-s mx-auto max-w-[26ch] text-center !leading-[1.22]">
          {splitWords(TEXT)}
        </p>
      </div>
    </section>
  )
}
