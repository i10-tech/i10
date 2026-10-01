"use client"

import { useRef, type CSSProperties, type ReactNode } from "react"
import { IconTile } from "@/components/brand/icon-tile"
import { splitWords } from "@/components/motion/split-reveal"
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/gsap"
import type { Hue, IconName } from "@/lib/site"

/*
 * A paragraph that lights up as you read it, after Dub's. Words brighten one
 * after another as the scroll passes them; each fades over about three words'
 * worth of scroll, so the edge moves word by word without any single word
 * snapping on. Each icon tile lights when
 * the reading reaches it, and the most recent one is "active": it tips over
 * and lifts, and a glow in its colour tints the words around it.
 *
 * The glow is a multiply layer painted over the text: white text times the
 * hue is the hue, the near-black canvas times anything stays near-black, so
 * only the letters take the colour.
 *
 * ⚠ NOTHING BETWEEN THE GLOW AND THE PARAGRAPH MAY TRANSFORM. A transform
 * (Tailwind's translate-* included) makes a stacking context, which isolates
 * the blend: the glow then multiplies with nothing and paints as a box. The
 * tile's resting nudge lives on .mf-tile, beside the glow, not around it.
 */
function Inline({ icon, hue, tilt }: { icon: IconName; hue: Hue; tilt: number }) {
  return (
    <span
      className="mf-icon relative mx-[0.12em] inline-flex align-middle"
      style={{ "--glow": `var(--hue-${hue})`, "--tilt": `${tilt}deg` } as CSSProperties}
    >
      <span
        aria-hidden
        className="mf-glow pointer-events-none absolute top-1/2 left-1/2 h-[3.4em] w-[8em] -translate-x-1/2 -translate-y-1/2"
      />
      <span className="mf-tile relative inline-flex">
        <IconTile
          icon={icon}
          hue={hue}
          size="md"
          className="size-[0.86em] rounded-[0.22em] [&_svg]:size-[0.46em]"
        />
      </span>
    </span>
  )
}

const TEXT: ReactNode = (
  <>
    Email is the one API every product needs <Inline icon="send" hue="send" tilt={10} />{" "}
    and nobody wants to own. i10 signs every message{" "}
    <Inline icon="shield" hue="deliver" tilt={-10} />, sends it from Frankfurt{" "}
    <Inline icon="globe" hue="domain" tilt={10} />, and lands it in the inbox under a
    domain that is actually yours. It speaks Resend{" "}
    <Inline icon="code" hue="template" tilt={-10} />, so switching is one line. And when
    your team wants real mailboxes <Inline icon="mailbox" hue="mail" tilt={10} />, they
    are already there.
  </>
)

const STAGGER = 0.1

export function Manifesto() {
  const root = useRef<HTMLParagraphElement>(null)

  useGSAP(
    () => {
      const el = root.current
      if (!el || prefersReducedMotion()) return
      const words = gsap.utils.toArray<HTMLElement>(".sw-i", el)
      const icons = gsap.utils.toArray<HTMLElement>(".mf-icon", el)

      // Where each icon sits in the reading order: the index of the first
      // word after it, so it lights as the word before it finishes.
      const at = icons.map((icon) => {
        const next = words.findIndex(
          (w) => icon.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING,
        )
        return (next < 0 ? words.length : next) * STAGGER
      })

      let active = -1
      const setActive = (index: number) => {
        if (index === active) return
        icons[active]?.removeAttribute("data-active")
        icons[index]?.setAttribute("data-active", "")
        active = index
      }

      gsap.set(words, { opacity: 0.18 })
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: el,
          start: "top 80%",
          end: "bottom 45%",
          scrub: 0.6,
          onLeaveBack: () => setActive(-1),
        },
        onUpdate: () => {
          const t = tl.time()
          let index = -1
          at.forEach((time, i) => {
            if (t >= time - STAGGER) index = i
          })
          setActive(index)
        },
      })
      tl.to(
        words,
        { opacity: 1, ease: "power1.in", duration: STAGGER * 3, stagger: STAGGER },
        0,
      )
      icons.forEach((icon, i) => {
        tl.fromTo(
          icon.querySelector(".icon-tile"),
          { opacity: 0.3, scale: 0.82, filter: "grayscale(1)" },
          {
            opacity: 1,
            scale: 1,
            filter: "grayscale(0)",
            duration: 0.5,
            ease: "back.out(2.4)",
          },
          Math.max(0, at[i]! - STAGGER * 2),
        )
      })
    },
    { scope: root },
  )

  return (
    <section data-nav-tone="dark" className="relative py-28 md:py-40">
      <div className="container-site">
        {/* data-split-done: the words are only ever faded, never moved, so
            they stay plain inline text from the start. */}
        <p
          ref={root}
          data-split-done
          className="type-display-s mx-auto max-w-[26ch] text-center !leading-[1.22]"
        >
          {splitWords(TEXT)}
        </p>
      </div>
    </section>
  )
}
