"use client"

import { useRef } from "react"
import { Frame } from "@/components/site/section"
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/gsap"

/*
 * Three principles as figures, after Linear's FIG 0.1-0.3: isometric line
 * drawings whose strokes draw themselves in as the row scrolls into view.
 *
 * The geometry is generated, not hand-drawn: `box()` projects an axis-aligned
 * box through a 30-degree isometric transform and returns only the edges a
 * viewer would see, so every figure shares one light and one angle.
 */
const COS = Math.cos(Math.PI / 6)
const SIN = Math.sin(Math.PI / 6)
const iso = (x: number, y: number, z: number): [number, number] => [(x - y) * COS, (x + y) * SIN - z]
const pt = (p: [number, number]) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`

/*
 * A box is its silhouette (filled with the canvas, so a nearer box hides the
 * edges of a farther one, the way Linear's figures do) plus its visible edges.
 * Boxes must be listed back to front; larger x + y is nearer the viewer.
 */
interface Shape {
  fill?: string
  strokes: string[]
}

function box(x: number, y: number, z: number, w: number, d: number, h: number): Shape {
  const t = [iso(x, y, z + h), iso(x + w, y, z + h), iso(x + w, y + d, z + h), iso(x, y + d, z + h)]
  const b = [iso(x + w, y, z), iso(x + w, y + d, z), iso(x, y + d, z)]
  return {
    fill: `M${pt(t[0]!)}L${pt(t[1]!)}L${pt(b[0]!)}L${pt(b[1]!)}L${pt(b[2]!)}L${pt(t[3]!)}Z`,
    strokes: [
      `M${pt(t[0]!)}L${pt(t[1]!)}L${pt(t[2]!)}L${pt(t[3]!)}Z`,
      `M${pt(t[1]!)}L${pt(b[0]!)}L${pt(b[1]!)}L${pt(b[2]!)}L${pt(t[3]!)}`,
      `M${pt(t[2]!)}L${pt(b[1]!)}`,
    ],
  }
}

function envelopeOnTop(x: number, y: number, z: number, w: number, d: number): Shape {
  // An envelope flap drawn onto a top face: the rim inset, and the V.
  const i = 14
  const a = iso(x + i, y + i, z)
  const b = iso(x + w - i, y + i, z)
  const c = iso(x + w - i, y + d - i, z)
  const e = iso(x + i, y + d - i, z)
  const m = iso(x + w / 2, y + d / 2 + 6, z)
  return { strokes: [`M${pt(a)}L${pt(b)}L${pt(c)}L${pt(e)}Z`, `M${pt(a)}L${pt(m)}L${pt(b)}`] }
}

const FIGS = [
  {
    fig: "FIG 0.1",
    title: "Compatible by design",
    body: "The same requests, responses and error names as Resend. Your call sites never find out.",
    shapes: [box(0, 0, 0, 130, 130, 14), box(0, 0, 46, 130, 130, 14), envelopeOnTop(0, 0, 60, 130, 130)],
    dashed: [
      `M${pt(iso(0, 130, 14))}L${pt(iso(0, 130, 46))}`,
      `M${pt(iso(130, 130, 14))}L${pt(iso(130, 130, 46))}`,
      `M${pt(iso(130, 0, 14))}L${pt(iso(130, 0, 46))}`,
    ],
  },
  {
    fig: "FIG 0.2",
    title: "Aligned from the first send",
    body: "SPF and DKIM both align, so the inbox shows your domain. One record to start, two to own it.",
    shapes: [box(0, 0, 0, 56, 56, 28), box(0, 60, 0, 56, 56, 56), box(64, 0, 0, 56, 56, 84), box(64, 64, 0, 56, 56, 40)],
    dashed: [],
  },
  {
    fig: "FIG 0.3",
    title: "Mail that stays yours",
    body: "Bodies sealed in per-workspace packs, sent from Frankfurt. Ten slats: one for every letter i10 leaves out.",
    shapes: Array.from({ length: 10 }, (_, i) => box(i * 13, 0, 0, 5, 118, 120 - i * 10)),
    dashed: [],
  },
]

export function Principles() {
  const root = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      const figures = gsap.utils.toArray<HTMLElement>("[data-fig]")
      if (prefersReducedMotion()) return
      figures.forEach((fig, i) => {
        const strokes = fig.querySelectorAll<SVGPathElement>("path:not([data-fill])")
        gsap.fromTo(
          strokes,
          { drawSVG: "0%" },
          {
            drawSVG: "100%",
            duration: 1.6,
            ease: "site.inOut",
            stagger: 0.05,
            delay: i * 0.15,
            scrollTrigger: { trigger: root.current, start: "top 75%", once: true },
          },
        )
      })
    },
    { scope: root },
  )

  return (
    <Frame className="mt-28 md:mt-36">
      <div ref={root} className="grid md:grid-cols-3">
        {FIGS.map((f, i) => (
          <div key={f.fig} className="relative flex flex-col px-2 pt-10 pb-12 md:px-8 md:first:pl-2 md:last:pr-2">
            {i > 0 ? <div aria-hidden className="absolute inset-y-10 left-0 w-px bg-line-faint max-md:hidden" /> : null}
            <span data-reveal className="type-label text-fg-4">
              {f.fig}
            </span>
            <div data-fig className="my-10 flex h-[220px] items-center justify-center">
              <svg viewBox="-130 -110 260 250" className="h-full w-auto overflow-visible" aria-hidden>
                {f.dashed.map((d) => (
                  <path key={d} d={d} fill="none" stroke="var(--line-bright)" strokeWidth="1" strokeDasharray="2 4" />
                ))}
                {f.shapes.map((shape, j) => (
                  <g key={j}>
                    {shape.fill ? <path data-fill d={shape.fill} fill="var(--canvas)" /> : null}
                    {shape.strokes.map((d, k) => (
                      <path key={k} d={d} fill="none" stroke="rgb(255 255 255 / 0.42)" strokeWidth="1" strokeLinejoin="round" strokeLinecap="round" />
                    ))}
                  </g>
                ))}
              </svg>
            </div>
            <h3 data-reveal className="text-[16px] font-[540] tracking-[-0.01em] text-fg">
              {f.title}
            </h3>
            <p data-reveal className="mt-2 max-w-[22rem] text-[15px] leading-[24px] text-fg-3">
              {f.body}
            </p>
          </div>
        ))}
      </div>
    </Frame>
  )
}
