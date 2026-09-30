import Link from "next/link"
import { IconTile } from "@/components/brand/icon-tile"
import { ArrowUpRight, Arrow } from "@/components/ui/button-link"
import { Badge } from "@/components/ui/badge"
import { CopyButton } from "@/components/ui/copy-button"
import { changelog, formatDate } from "@/lib/changelog"
import { developerNav, productNav, resourceNav, type NavItem } from "@/lib/site"

function PanelItem({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  const external = item.external
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="group flex items-start gap-3 rounded-[12px] p-2.5 transition-colors duration-150 hover:bg-white/[0.04] focus-visible:bg-white/[0.04]"
    >
      {item.icon ? <IconTile icon={item.icon} hue={item.hue} /> : null}
      <span className="flex min-w-0 flex-col gap-0.5 pt-px">
        <span className="flex items-center gap-2 text-[13.5px] leading-5 font-[520] text-fg">
          {item.title}
          {item.badge ? <Badge kind={item.badge} /> : null}
          {external ? <ArrowUpRight className="text-fg-4 transition-colors group-hover:text-fg-2" /> : null}
        </span>
        {item.description ? (
          <span className="text-[12.5px] leading-[18px] text-fg-3 transition-colors group-hover:text-fg-2">{item.description}</span>
        ) : null}
      </span>
    </Link>
  )
}

function PanelFoot({ label, children, href, cta, onNavigate }: { label: string; children: React.ReactNode; href: string; cta: string; onNavigate: () => void }) {
  return (
    <div className="flex items-center justify-between gap-6 border-t border-line px-5 py-3">
      <p className="truncate text-[12.5px] text-fg-3">
        <span className="mr-2 font-[520] text-brand">{label}</span>
        {children}
      </p>
      <Link href={href} onClick={onNavigate} className="group/btn inline-flex shrink-0 items-center gap-1.5 text-[12.5px] text-fg-2 transition-colors hover:text-fg">
        {cta}
        <Arrow />
      </Link>
    </div>
  )
}

export function ProductPanel({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="w-[760px]">
      <div className="grid grid-cols-[1fr_236px] gap-2 p-2">
        <div className="grid grid-cols-2 gap-0.5">
          {productNav.map((item) => (
            <PanelItem key={item.href} item={item} onNavigate={onNavigate} />
          ))}
        </div>
        <Link
          href="/migrate/resend"
          onClick={onNavigate}
          className="group/btn relative flex flex-col justify-between overflow-hidden rounded-[12px] border border-line bg-surface-1 p-4"
        >
          <span className="type-label text-fg-3">Migrate in a minute</span>
          <span className="mt-4 flex flex-col gap-1 font-mono text-[11px] leading-[18px]">
            <span className="rounded-[4px] bg-bounced/10 px-1.5 text-bounced/90">- from &quot;resend&quot;</span>
            <span className="rounded-[4px] bg-delivered/10 px-1.5 text-delivered">+ from &quot;@i10/node&quot;</span>
          </span>
          <span className="mt-5">
            <span className="block text-[13.5px] font-[520] text-fg">Keep your code.</span>
            <span className="flex items-center gap-1.5 text-[12.5px] text-fg-3 transition-colors group-hover/btn:text-fg-2">
              Change one import <Arrow />
            </span>
          </span>
        </Link>
      </div>
      <PanelFoot label="New" href="/changelog" cta="Changelog" onNavigate={onNavigate}>
        Templates connected to GitHub: push to main, live in seconds.
      </PanelFoot>
    </div>
  )
}

export function DevelopersPanel({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="w-[700px]">
      <div className="grid grid-cols-[1fr_240px] gap-2 p-2">
        <div className="grid grid-cols-2 gap-0.5">
          {developerNav.map((item) => (
            <PanelItem key={item.href} item={item} onNavigate={onNavigate} />
          ))}
        </div>
        <div className="flex flex-col justify-between rounded-[12px] border border-line bg-surface-1 p-4">
          <span className="type-label text-fg-3">Install</span>
          <div className="mt-4 flex items-center justify-between rounded-[8px] border border-line bg-canvas py-1 pr-1 pl-3 font-mono text-[12px] text-fg-2">
            <span>
              <span className="text-fg-4">$ </span>bun add @i10/node
            </span>
            <CopyButton value="bun add @i10/node" />
          </div>
          <p className="mt-4 text-[12.5px] leading-[18px] text-fg-3">
            Zero runtime dependencies. Typed errors with <span className="font-mono text-fg-2">retryable</span> computed for you.
          </p>
        </div>
      </div>
      <PanelFoot label="API" href="/status" cta="System status" onNavigate={onNavigate}>
        Hosted in eu-central-1, Frankfurt.
      </PanelFoot>
    </div>
  )
}

export function ResourcesPanel({ onNavigate }: { onNavigate: () => void }) {
  const recent = changelog.slice(0, 3)
  return (
    <div className="w-[640px]">
      <div className="grid grid-cols-[1fr_300px] gap-2 p-2">
        <div className="flex flex-col gap-0.5">
          {resourceNav.map((item) => (
            <PanelItem key={item.href} item={item} onNavigate={onNavigate} />
          ))}
        </div>
        <div className="flex flex-col rounded-[12px] border border-line bg-surface-1 p-4">
          <span className="type-label text-fg-3">Latest shipped</span>
          <ul className="mt-3 flex flex-col">
            {recent.map((entry) => (
              <li key={entry.title} className="border-t border-line-faint py-2.5 first:border-t-0 first:pt-1">
                <Link href="/changelog" onClick={onNavigate} className="group block">
                  <span className="block font-mono text-[10.5px] tracking-wide text-fg-4 uppercase">{formatDate(entry.date)}</span>
                  <span className="mt-1 block text-[13px] leading-[18px] text-fg-2 transition-colors group-hover:text-fg">{entry.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
