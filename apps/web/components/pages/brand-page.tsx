import type { CSSProperties } from "react"
import { cn } from "cn"
import { Mark, MARK_PATH, MARK_VIEWBOX } from "@/components/brand/mark"
import { Closing } from "@/components/home/closing"
import { Frame, SectionHeader } from "@/components/site/section"
import { CopyButton } from "@/components/ui/copy-button"
import type { SpecialPage } from "@/lib/pages"
import { PageHero } from "./page-hero"

const svgFor = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX}"><path transform="skewX(-10)" fill="${fill}" fill-rule="evenodd" d="${MARK_PATH}"/></svg>`

const TILES = [
  {
    name: "On canvas",
    bg: "var(--canvas)",
    fg: "var(--brand)",
    fill: "#fbd530",
    ring: true,
  },
  {
    name: "On post yellow",
    bg: "var(--brand)",
    fg: "var(--brand-ink)",
    fill: "#0b0b0c",
  },
  { name: "On paper", bg: "#ededef", fg: "var(--brand-ink)", fill: "#0b0b0c" },
]

const COLORS = [
  { name: "Post yellow", token: "--brand", value: "#fbd530", swatch: "var(--brand)" },
  { name: "Ink", token: "--brand-ink", value: "#0b0b0c", swatch: "var(--brand-ink)" },
  { name: "Canvas", token: "--canvas", value: "#09090b", swatch: "var(--canvas)" },
  {
    name: "Surface",
    token: "--surface-2",
    value: "#131316",
    swatch: "var(--surface-2)",
  },
  { name: "Foreground", token: "--fg", value: "#ededef", swatch: "var(--fg)" },
  { name: "Muted", token: "--fg-3", value: "#74747d", swatch: "var(--fg-3)" },
]

const LETTERS = "ntegration".split("")

/*
 * The brand in one page: the mark on the three grounds it is allowed on, how
 * it is drawn, where the name comes from, the colours and the type, and the
 * handful of things never to do to it. Every SVG copied here is generated
 * from the same MARK_PATH the site renders, so the download cannot drift.
 */
export function BrandPageView({ page }: { page: SpecialPage }) {
  return (
    <>
      <PageHero eyebrow={page.eyebrow} title={page.title} lede={page.lede} />

      <Frame className="py-20 md:py-24">
        <SectionHeader
          title="The mark."
          muted="An i, a one and a zero, sheared ten degrees as one."
          size="s"
        />
        <div data-reveal className="mt-10 grid gap-3 md:grid-cols-3">
          {TILES.map((t) => (
            <div
              key={t.name}
              className={cn(
                "group relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-[20px]",
                t.ring && "shadow-[inset_0_0_0_1px_var(--line)]",
              )}
              style={{ background: t.bg }}
            >
              <Mark
                className="h-[34%] transition-transform duration-500 ease-[var(--ease-out-expo)] group-hover:scale-[1.06]"
                style={{ color: t.fg }}
              />
              <div className="absolute inset-x-3 bottom-3 flex items-center justify-between">
                <span
                  className="font-mono text-[11px]"
                  style={{ color: t.fg, opacity: 0.7 }}
                >
                  {t.name}
                </span>
                <span
                  className="rounded-md opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                  style={{ color: t.fg } as CSSProperties}
                >
                  <CopyButton
                    value={svgFor(t.fill)}
                    label={`Copy SVG, ${t.name.toLowerCase()}`}
                    className="text-current hover:bg-black/10"
                  />
                </span>
              </div>
            </div>
          ))}
        </div>

        <div data-reveal className="mt-3 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
          <div className="relative overflow-hidden rounded-[20px] bg-surface-1 p-8 shadow-[inset_0_0_0_1px_var(--line)]">
            <span className="type-label text-fg-4">Construction</span>
            <svg
              viewBox="-40 -24 220 150"
              className="mt-6 h-[clamp(200px,24vw,320px)] w-full"
              aria-label="The mark drawn on its construction grid"
            >
              <defs>
                <pattern
                  id="brand-grid"
                  width="12"
                  height="12"
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d="M12 0H0v12"
                    fill="none"
                    stroke="rgb(255 255 255 / 0.05)"
                    strokeWidth="0.4"
                  />
                </pattern>
              </defs>
              <rect x="-40" y="-24" width="220" height="150" fill="url(#brand-grid)" />
              <line
                x1="-40"
                x2="180"
                y1="0"
                y2="0"
                stroke="var(--fg-4)"
                strokeWidth="0.4"
                strokeDasharray="2 2"
              />
              <line
                x1="-40"
                x2="180"
                y1="100"
                y2="100"
                stroke="var(--fg-4)"
                strokeWidth="0.4"
                strokeDasharray="2 2"
              />
              <line
                x1="0"
                x2="-17.63"
                y1="0"
                y2="100"
                stroke="var(--brand)"
                strokeWidth="0.5"
              />
              <line
                x1="0"
                x2="0"
                y1="0"
                y2="100"
                stroke="var(--fg-4)"
                strokeWidth="0.4"
                strokeDasharray="2 2"
              />
              <path
                transform="skewX(-10)"
                fillRule="evenodd"
                d={MARK_PATH}
                fill="rgb(255 255 255 / 0.04)"
                stroke="var(--fg-2)"
                strokeWidth="0.5"
              />
              <text x="-36" y="-8" className="fill-fg-4 font-mono text-[5px]">
                cap height 100
              </text>
              <text x="4" y="112" className="fill-brand font-mono text-[5px]">
                −10° shear
              </text>
              <text x="132" y="-8" className="fill-fg-4 font-mono text-[5px]">
                1 : 1.55
              </text>
            </svg>
          </div>
          <div className="flex flex-col justify-between gap-8 rounded-[20px] bg-surface-1 p-8 shadow-[inset_0_0_0_1px_var(--line)]">
            <span className="type-label text-fg-4">The name</span>
            <div>
              <div className="flex items-end font-display text-[clamp(34px,4.4vw,52px)] leading-none font-[580] tracking-[-0.04em]">
                <span className="text-brand">i</span>
                {LETTERS.map((l, i) => (
                  <span key={i} className="relative text-fg-3">
                    <span className="absolute -top-5 left-1/2 -translate-x-1/2 font-mono text-[9px] font-normal tracking-normal text-fg-4">
                      {i + 1}
                    </span>
                    {l}
                  </span>
                ))}
              </div>
              <p className="mt-6 max-w-[24rem] text-[14px] leading-[22px] text-fg-3">
                An i, then ten letters: integration. Written lowercase, always,
                including at the start of a sentence.
              </p>
            </div>
          </div>
        </div>
      </Frame>

      <Frame className="py-24">
        <SectionHeader
          title="Colour."
          muted="One yellow, and a lot of dark."
          size="s"
        />
        <div
          data-reveal
          className="mt-10 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
        >
          {COLORS.map((c) => (
            <div
              key={c.token}
              className="group overflow-hidden rounded-[16px] bg-surface-1 shadow-[inset_0_0_0_1px_var(--line)]"
            >
              <div
                className="m-1.5 h-24 rounded-[11px] shadow-[inset_0_0_0_1px_var(--line)]"
                style={{ background: c.swatch }}
              />
              <div className="flex items-start justify-between gap-2 px-4 pt-2.5 pb-4">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-[540] text-fg">{c.name}</p>
                  <p className="mt-1 truncate font-mono text-[11px] text-fg-4">
                    {c.value}
                  </p>
                </div>
                <CopyButton
                  value={c.value}
                  label={`Copy ${c.name}`}
                  className="-mt-1 -mr-1.5"
                />
              </div>
            </div>
          ))}
        </div>
      </Frame>

      <Frame className="py-24">
        <SectionHeader title="Type." muted="Three faces, three jobs." size="s" />
        <div data-reveal className="mt-10 grid gap-3 lg:grid-cols-3">
          <Specimen
            name="Inter Display"
            role="Headlines and interface"
            className="font-display font-[570] tracking-[-0.04em]"
            sample="Send it."
          />
          <Specimen
            name="Instrument Serif Italic"
            role="One accent word, never more"
            className="font-serif tracking-[-0.01em] italic"
            sample="everyone"
          />
          <Specimen
            name="Geist Mono"
            role="Code, labels and data"
            className="font-mono tracking-[-0.03em]"
            sample="i10_live_"
          />
        </div>
      </Frame>

      <Frame className="py-24">
        <SectionHeader title="Please don't." size="s" />
        <div data-reveal className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { note: "Stretch or squash it", style: { transform: "scaleX(1.45)" } },
            { note: "Straighten the slant", style: { transform: "skewX(10deg)" } },
            { note: "Recolour it", style: { color: "oklch(0.68 0.19 25)" } },
            { note: "Put it on a busy ground", busy: true, style: {} },
          ].map((d) => (
            <div
              key={d.note}
              className="overflow-hidden rounded-[16px] bg-surface-1 shadow-[inset_0_0_0_1px_var(--line)]"
            >
              <div
                className={cn(
                  "relative flex h-36 items-center justify-center",
                  d.busy && "brand-busy",
                )}
              >
                <Mark className="h-10 text-brand" style={d.style as CSSProperties} />
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className="absolute top-3 right-3 size-4 text-bounced"
                >
                  <path
                    d="m4 4 8 8m0-8-8 8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
              <p className="border-t border-line px-4 py-3 text-[13px] text-fg-3">
                {d.note}
              </p>
            </div>
          ))}
        </div>
      </Frame>

      <Closing />
    </>
  )
}

function Specimen({
  name,
  role,
  sample,
  className,
}: {
  name: string
  role: string
  sample: string
  className: string
}) {
  return (
    // A size container, so the sample scales with its card (17cqw keeps the
    // widest sample, the mono key prefix, inside the padding at every width).
    <div className="flex min-h-[260px] flex-col justify-between rounded-[20px] bg-surface-1 p-7 shadow-[inset_0_0_0_1px_var(--line)] [container-type:inline-size]">
      <span
        className={cn("text-[clamp(36px,17cqw,64px)] leading-none text-fg", className)}
      >
        {sample}
      </span>
      <div>
        <p className="text-[14px] font-[540] text-fg">{name}</p>
        <p className="mt-1 text-[13px] text-fg-3">{role}</p>
      </div>
    </div>
  )
}
