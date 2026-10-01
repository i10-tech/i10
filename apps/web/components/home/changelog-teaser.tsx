import Link from "next/link"
import { Frame } from "@/components/site/section"
import { Arrow } from "@/components/ui/button-link"
import { changelog, formatDate } from "@/lib/changelog"

/*
 * Linear's changelog row, fed by the repository's own history. A launch site
 * that shows what shipped on Tuesday says more about a team than a slogan.
 */
export function ChangelogTeaser() {
  const entries = changelog.slice(0, 3)
  return (
    <Frame className="py-24 md:py-28">
      <div className="flex items-end justify-between gap-6">
        <h2 data-reveal className="type-display-m">
          Changelog
        </h2>
        <Link
          data-reveal
          href="/changelog"
          className="group/btn inline-flex items-center gap-1.5 text-[14px] text-fg-2 transition-colors hover:text-fg"
        >
          View all <Arrow />
        </Link>
      </div>
      <div
        data-reveal
        className="mt-10 grid gap-px overflow-hidden rounded-[18px] bg-line md:grid-cols-3"
      >
        {entries.map((entry) => (
          <Link
            key={entry.title}
            href="/changelog"
            className="group flex min-h-[220px] flex-col bg-canvas p-6 transition-colors duration-300 hover:bg-surface-1"
          >
            <span className="type-label text-fg-4">{entry.tag}</span>
            <p className="mt-5 text-[16px] leading-6 font-[540] tracking-[-0.01em] text-fg">
              {entry.title}
            </p>
            <p className="mt-2 text-[14px] leading-[22px] text-fg-3">{entry.summary}</p>
            <span className="mt-auto flex items-center justify-between pt-6 font-mono text-[11px] tracking-wide text-fg-4 uppercase">
              {formatDate(entry.date)}
              {entry.pr ? <span>#{entry.pr}</span> : null}
            </span>
          </Link>
        ))}
      </div>
    </Frame>
  )
}
