import type { Metadata } from "next"
import type { ReactNode } from "react"
import { cn } from "cn"
import { IconTile } from "@/components/brand/icon-tile"
import { ICON_NAMES } from "@/components/brand/pixel-icon"
import { DesignNav, MotionBench, Swatch, TypeScale } from "@/components/design/design-client"
import { PageHero } from "@/components/pages/page-hero"
import { Eyebrow, Frame, SectionHeader } from "@/components/site/section"
import { StatusPill } from "@/components/site/status-pill"
import { Badge, Pill } from "@/components/ui/badge"
import { ButtonLink } from "@/components/ui/button-link"
import { highlight } from "@/components/ui/code"
import { CopyButton } from "@/components/ui/copy-button"
import type { Hue } from "@/lib/site"

export const metadata: Metadata = {
  title: "Design system",
  description: "The tokens, type, colour, motion and components i10's site and console are built from.",
}

/*
 * The design system, rendered from the real thing. Nothing here is a picture
 * of a component: every swatch reads its CSS variable, every button is the
 * ButtonLink the site uses, every icon is the PixelIcon in the nav. When the
 * console adopts the system it adopts these files, and this page is where a
 * change is seen first.
 */
const COLOUR_GROUPS: { title: string; note: string; tokens: [string, string, boolean?][] }[] = [
  {
    title: "Surfaces",
    note: "Each step is one notch lighter. Cards sit on surface-1, controls on surface-3.",
    tokens: [
      ["--canvas", "#09090b", true],
      ["--surface-1", "#0e0e11", true],
      ["--surface-2", "#131316", true],
      ["--surface-3", "#1a1a1e", true],
      ["--surface-4", "#222227", true],
    ],
  },
  {
    title: "Text",
    note: "Four steps, and fg-4 is for labels only - never body copy.",
    tokens: [
      ["--fg", "#ededef"],
      ["--fg-2", "#a3a3ab"],
      ["--fg-3", "#74747d", true],
      ["--fg-4", "#4e4e56", true],
    ],
  },
  {
    title: "Brand",
    note: "Post yellow is the accent. It is never a background for more than one element per screen.",
    tokens: [
      ["--brand", "oklch(0.88 0.17 95)"],
      ["--brand-soft", "brand / 14%", true],
      ["--brand-ink", "#0b0b0c", true],
    ],
  },
  {
    title: "Product hues",
    note: "For icon tiles and drawings. Never for text, never for state.",
    tokens: [
      ["--hue-send", "oklch(0.72 0.15 252)"],
      ["--hue-mail", "oklch(0.72 0.16 295)"],
      ["--hue-domain", "oklch(0.78 0.15 155)"],
      ["--hue-template", "oklch(0.74 0.16 350)"],
      ["--hue-hook", "oklch(0.78 0.15 60)"],
      ["--hue-deliver", "oklch(0.8 0.12 205)"],
    ],
  },
  {
    title: "Delivery state",
    note: "The four states a message can be in, the same in every chart and chip.",
    tokens: [
      ["--state-delivered", "oklch(0.78 0.16 152)"],
      ["--state-queued", "oklch(0.74 0.13 248)"],
      ["--state-complained", "oklch(0.83 0.15 78)"],
      ["--state-bounced", "oklch(0.68 0.19 25)"],
    ],
  },
]

const LINES = [
  ["--line-faint", "4.5%", "Rails and dividers inside a card"],
  ["--line", "7.5%", "Card edges and section seams"],
  ["--line-strong", "12%", "Controls, hover edges"],
  ["--line-bright", "20%", "Focus and pressed states"],
]

const RADII = [
  { r: 8, use: "Small tiles, inline code" },
  { r: 10, use: "Icon tiles, swatches" },
  { r: 14, use: "Inner cards, notices" },
  { r: 16, use: "Cards, code windows" },
  { r: 20, use: "Feature cards" },
  { r: 24, use: "Windows, hero cards" },
  { r: 28, use: "The closing card" },
  { r: 999, use: "Buttons, pills, tabs" },
]

const DURATIONS = [
  ["--dur-hover", 120, "Colour on hover"],
  ["--dur-quick", 200, "Small state changes"],
  ["--dur-base", 320, "Menus and panels"],
  ["--dur-move", 560, "Things that travel"],
  ["--dur-slow", 900, "Reveals"],
] as const

const HUES: Hue[] = ["send", "mail", "domain", "template", "hook", "deliver"]

export default function DesignPage() {
  return (
    <>
      <PageHero
        eyebrow="Labs · Design system"
        color="var(--hue-mail)"
        title={
          <>
            The parts i10 is <span className="type-accent">built from.</span>
          </>
        }
        lede="Tokens, type, colour, motion and components - rendered from the same files the site uses, so this page can never drift from the product."
      />

      <DesignNav />

      <Frame id="colour" className="scroll-mt-24 py-24">
        <SectionHeader eyebrow={<Eyebrow>Colour</Eyebrow>} title="A lot of dark," muted="one yellow, and nothing loud." size="s" />
        <div className="mt-12 flex flex-col gap-12">
          {COLOUR_GROUPS.map((g) => (
            <div key={g.title} data-reveal className="grid gap-5 lg:grid-cols-[220px_1fr] lg:gap-10">
              <div>
                <p className="text-[14px] font-[540] text-fg">{g.title}</p>
                <p className="mt-1.5 text-[13px] leading-5 text-fg-3">{g.note}</p>
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
                {g.tokens.map(([token, value, dark]) => (
                  <Swatch key={token} token={token} value={value} dark={dark} />
                ))}
              </div>
            </div>
          ))}
          <div data-reveal className="grid gap-5 lg:grid-cols-[220px_1fr] lg:gap-10">
            <div>
              <p className="text-[14px] font-[540] text-fg">Hairlines</p>
              <p className="mt-1.5 text-[13px] leading-5 text-fg-3">White at low alpha, so a line reads the same on every surface.</p>
            </div>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {LINES.map(([token, alpha, use]) => (
                <div key={token} className="rounded-[14px] bg-surface-1 p-4 shadow-[inset_0_0_0_1px_var(--line)]">
                  <div className="h-px" style={{ background: `var(${token})` }} />
                  <div className="mt-4 flex items-baseline justify-between gap-3">
                    <span className="font-mono text-[11.5px] text-fg">{token}</span>
                    <span className="font-mono text-[10.5px] text-fg-4">{alpha}</span>
                  </div>
                  <p className="mt-1 text-[12.5px] text-fg-3">{use}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Frame>

      <Frame id="type" className="scroll-mt-24 py-24">
        <SectionHeader
          eyebrow={<Eyebrow>Type</Eyebrow>}
          title="Inter Display,"
          muted="one serif accent, and mono for the machine."
          description="Display sizes are fluid clamps on Inter's optical-size axis, set tight. The numbers beside each step are read from your browser at this width."
          size="s"
        />
        <div data-reveal className="mt-12">
          <TypeScale />
        </div>
      </Frame>

      <Frame id="shape" className="scroll-mt-24 py-24">
        <SectionHeader
          eyebrow={<Eyebrow>Shape</Eyebrow>}
          title="Radii nest."
          muted="Inner equals outer minus the gap."
          description="A card of 20 with a 6px inset holds a 14. Get it wrong and the corners stop looking concentric, which reads as sloppy before anyone can say why."
          size="s"
        />
        <div data-reveal className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {RADII.map(({ r, use }) => (
            <div key={r} className="flex flex-col gap-4 rounded-[16px] bg-surface-1 p-4 shadow-[inset_0_0_0_1px_var(--line)]">
              <div className="grid h-24 place-items-center">
                <div
                  className="bg-surface-3 shadow-[inset_0_0_0_1px_var(--line-strong)]"
                  style={{ borderRadius: r === 999 ? 999 : r, width: r === 999 ? 96 : 64, height: r === 999 ? 36 : 64 }}
                />
              </div>
              <div>
                <p className="font-mono text-[12px] text-fg">{r === 999 ? "full" : `${r}px`}</p>
                <p className="mt-0.5 text-[12.5px] leading-[18px] text-fg-3">{use}</p>
              </div>
            </div>
          ))}
        </div>
        <div data-reveal className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="flex items-center gap-6 rounded-[20px] bg-surface-1 p-1.5 shadow-[inset_0_0_0_1px_var(--line)]">
            <div className="grid h-28 flex-1 place-items-center rounded-[14px] bg-surface-3 shadow-[inset_0_0_0_1px_var(--line-strong)]">
              <span className="font-mono text-[11px] text-fg-2">20 − 6 = 14</span>
            </div>
            <span className="pr-5 text-[12px] text-delivered">Concentric</span>
          </div>
          <div className="flex items-center gap-6 rounded-[20px] bg-surface-1 p-1.5 shadow-[inset_0_0_0_1px_var(--line)]">
            <div className="grid h-28 flex-1 place-items-center rounded-[20px] bg-surface-3 shadow-[inset_0_0_0_1px_var(--line-strong)]">
              <span className="font-mono text-[11px] text-fg-2">20 inside 20</span>
            </div>
            <span className="pr-5 text-[12px] text-bounced">Pinched</span>
          </div>
        </div>
      </Frame>

      <Frame id="motion" className="scroll-mt-24 py-24">
        <SectionHeader
          eyebrow={<Eyebrow>Motion</Eyebrow>}
          title="Everything moves,"
          muted="nothing jumps."
          description="Four curves and five durations, shared by CSS and GSAP under the same names. Scrolling is Lenis on GSAP's ticker, and all of it switches off under reduced motion."
          size="s"
        />
        <div className="mt-12 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
          <div data-reveal>
            <MotionBench />
          </div>
          <div data-reveal className="rounded-[20px] bg-surface-1 p-6 shadow-[inset_0_0_0_1px_var(--line)] md:p-8">
            <span className="type-label text-fg-4">Durations</span>
            <div className="mt-8 flex flex-col gap-5">
              {DURATIONS.map(([token, ms, use]) => (
                <div key={token}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-mono text-[11.5px] text-fg">{token}</span>
                    <span className="font-mono text-[11px] text-fg-3 tabular-nums">{ms}ms</span>
                  </div>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.05]">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${(ms / 900) * 100}%` }} />
                  </div>
                  <p className="mt-1.5 text-[12px] text-fg-4">{use}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Frame>

      <Frame id="icons" className="scroll-mt-24 py-24">
        <SectionHeader
          eyebrow={<Eyebrow>Icons</Eyebrow>}
          title="Nine by nine."
          muted="Hover one."
          description="Pixel icons on the same grid as the site's dither and barcode motifs. Each pixel carries a delay from its diagonal, so a hover lights the icon corner to corner in CSS alone."
          size="s"
        />
        <div data-reveal className="mt-12 grid grid-cols-3 gap-2.5 sm:grid-cols-6 lg:grid-cols-9">
          {ICON_NAMES.map((name, i) => (
            <div
              key={name}
              className="group flex flex-col items-center gap-3 rounded-[14px] bg-surface-1 px-2 py-5 shadow-[inset_0_0_0_1px_var(--line)] transition-colors duration-300 hover:bg-surface-2"
            >
              <IconTile icon={name} hue={HUES[i % HUES.length]} size="lg" />
              <span className="font-mono text-[10.5px] text-fg-3">{name}</span>
            </div>
          ))}
        </div>
      </Frame>

      <Frame id="components" className="scroll-mt-24 py-24">
        <SectionHeader eyebrow={<Eyebrow>Components</Eyebrow>} title="The pieces," muted="as they ship." size="s" />
        <div className="mt-12 grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
          <Specimen title="Buttons" note="Always links. The arrow is the only thing that moves.">
            <div className="flex flex-wrap items-center gap-3">
              <ButtonLink href="#components" arrow>
                Primary
              </ButtonLink>
              <ButtonLink href="#components" variant="brand">
                Brand
              </ButtonLink>
              <ButtonLink href="#components" variant="secondary">
                Secondary
              </ButtonLink>
              <ButtonLink href="#components" variant="ghost" arrow>
                Ghost
              </ButtonLink>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <ButtonLink href="#components" size="sm">
                Small
              </ButtonLink>
              <ButtonLink href="#components" size="md">
                Medium
              </ButtonLink>
              <ButtonLink href="#components" size="lg">
                Large
              </ButtonLink>
            </div>
          </Specimen>

          <Specimen title="Badges" note="Tiny caps beside a link; the pill form when a badge stands alone.">
            <div className="flex flex-wrap items-center gap-5">
              <span className="flex items-center gap-2 text-[14px] text-fg-2">
                Templates <Badge kind="new" />
              </span>
              <span className="flex items-center gap-2 text-[14px] text-fg-2">
                Broadcasts <Badge kind="beta" />
              </span>
              <span className="flex items-center gap-2 text-[14px] text-fg-2">
                Inbound <Badge kind="soon" />
              </span>
              <span className="flex items-center gap-2 text-[14px] text-fg-2">
                Design <Badge kind="labs" />
              </span>
            </div>
            <div className="mt-5">
              <Pill>New</Pill>
            </div>
          </Specimen>

          <Specimen title="Status" note="Measured, never asserted. Only operational pulses.">
            <StatusPill />
          </Specimen>

          <Specimen title="Eyebrow and copy" note="A square in the section's hue; copy confirms where the click landed.">
            <div className="flex items-center gap-6">
              <Eyebrow color="var(--hue-domain)">Domains</Eyebrow>
              <span className="flex items-center gap-2 rounded-[10px] bg-surface-2 py-1 pr-1 pl-3 font-mono text-[12px] text-fg-2 shadow-[inset_0_0_0_1px_var(--line)]">
                bun add @i10/node
                <CopyButton value="bun add @i10/node" />
              </span>
            </div>
          </Specimen>

          <Specimen title="Code" note="A small highlighter: strings, calls, keywords and punctuation." className="lg:col-span-2">
            <pre className="overflow-x-auto rounded-[14px] bg-canvas p-5 font-mono text-[12.5px] leading-[22px] shadow-[inset_0_0_0_1px_var(--line)]">
              <code>
                {highlight(
                  'import { I10 } from "@i10/node"\n\nconst client = new I10(process.env.I10_API_KEY)\n\nawait client.emails.send({\n  from: "Acme <hello@acme.co>",\n  to: "maya@northwind.dev",\n  subject: "Welcome to Acme",\n}, { idempotencyKey: "welcome-maya" })',
                )}
              </code>
            </pre>
          </Specimen>
        </div>
      </Frame>
    </>
  )
}

function Specimen({ title, note, className, children }: { title: string; note: string; className?: string; children: ReactNode }) {
  return (
    <div data-reveal className={cn("flex flex-col gap-8 rounded-[20px] bg-surface-1 p-6 shadow-[inset_0_0_0_1px_var(--line)] md:p-8", className)}>
      <div>
        <p className="text-[14px] font-[540] text-fg">{title}</p>
        <p className="mt-1 text-[13px] text-fg-3">{note}</p>
      </div>
      <div>{children}</div>
    </div>
  )
}
