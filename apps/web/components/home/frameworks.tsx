import type { CSSProperties } from "react"
import { cn } from "cn"
import { BrandIcon, brandHex, brandTitle, type BrandName } from "@/components/brand/brand-icon"
import { Eyebrow, Frame, SectionHeader } from "@/components/site/section"
import { ButtonLink } from "@/components/ui/button-link"
import { hosts } from "@/lib/site"

/*
 * Clerk's framework grid. At rest every mark is a thin monochrome glyph; on
 * hover the cell's dot matrix fades in from the centre, the mark lifts and
 * takes its own colour, and its name rises in underneath.
 *
 * Next.js and Node have first-party packages (@i10/next, @i10/node); the rest
 * send through the same REST API, which is all a framework needs.
 */
const FRAMEWORKS: { name: BrandName; label?: string; color?: string }[] = [
  { name: "next", label: "Next.js", color: "#ffffff" },
  { name: "node", label: "Node.js" },
  { name: "bun", label: "Bun", color: "#f9f1e1" },
  { name: "remix", label: "Remix", color: "#ffffff" },
  { name: "nuxt", label: "Nuxt" },
  { name: "astro", label: "Astro", color: "#ff5d01" },
]

const INTEGRATIONS: { name: BrandName; label: string; note: string; color?: string }[] = [
  { name: "cloudflare", label: "Cloudflare", note: "DNS in one click" },
  { name: "github", label: "GitHub", note: "Templates on push", color: "#ffffff" },
  { name: "react", label: "React Email", note: "Write mail in JSX" },
]

export function Frameworks() {
  return (
    <Frame className="py-24 md:py-32">
      <div className="grid gap-16 lg:grid-cols-2 lg:gap-10">
        <div className="flex flex-col items-center text-center">
          <SectionHeader
            align="center"
            size="s"
            eyebrow={<Eyebrow color="var(--hue-deliver)">Frameworks</Eyebrow>}
            title="SDKs for the stack you ship."
            description="First-party packages for Node and Next.js. Everything else speaks HTTP, and so does i10."
          >
            <ButtonLink href={`${hosts.docs}/sdks`} variant="ghost" arrow className="mx-auto">
              All SDKs
            </ButtonLink>
          </SectionHeader>
          <div data-reveal className="mt-12 grid w-full grid-cols-3 border-t border-l border-line">
            {FRAMEWORKS.map((f) => (
              <Cell key={f.name} name={f.name} label={f.label ?? brandTitle(f.name)} color={f.color} />
            ))}
          </div>
        </div>
        <div className="flex flex-col items-center text-center">
          <SectionHeader
            align="center"
            size="s"
            eyebrow={<Eyebrow color="var(--hue-mail)">Integrations</Eyebrow>}
            title="Plugged into your tools."
            description="Connect your DNS provider and your repository once. i10 does the rest on every send."
          >
            <ButtonLink href="/developers" variant="ghost" arrow className="mx-auto">
              All integrations
            </ButtonLink>
          </SectionHeader>
          <div data-reveal className="mt-12 grid w-full grid-cols-3 border-t border-l border-line">
            {INTEGRATIONS.map((f) => (
              <Cell key={f.name} name={f.name} label={f.label} note={f.note} color={f.color} tall />
            ))}
          </div>
        </div>
      </div>
    </Frame>
  )
}

function Cell({ name, label, note, color, tall }: { name: BrandName; label: string; note?: string; color?: string; tall?: boolean }) {
  return (
    <div
      // `tall` matches the two-row SDK grid beside it; stacked on a phone
      // there is nothing to match, so it stays one row high there.
      className={cn(
        "fw-cell group relative flex h-[145px] items-center justify-center overflow-hidden border-r border-b border-line",
        tall && "lg:h-[290px]",
      )}
      style={{ "--brand-c": color ?? brandHex(name) } as CSSProperties}
    >
      <span aria-hidden className="fw-dots absolute inset-0" />
      <span className="fw-icon relative flex flex-col items-center gap-3">
        <BrandIcon name={name} size={30} />
      </span>
      <span className="fw-label absolute inset-x-0 flex flex-col items-center text-[12.5px] font-[520] text-fg">
        {label}
        {note ? <span className="mt-0.5 text-[11.5px] font-normal text-fg-3">{note}</span> : null}
      </span>
    </div>
  )
}
