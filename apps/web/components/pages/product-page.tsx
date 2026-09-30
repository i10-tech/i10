import Link from "next/link"
import { IconTile } from "@/components/brand/icon-tile"
import { LineGraphic } from "@/components/fx/line-graphic"
import { Closing } from "@/components/home/closing"
import { SplitReveal } from "@/components/motion/split-reveal"
import { Frame, SectionHeader } from "@/components/site/section"
import { Badge } from "@/components/ui/badge"
import { Arrow, ButtonLink } from "@/components/ui/button-link"
import type { ProductPage } from "@/lib/pages"
import { hosts, productNav } from "@/lib/site"
import { PageHero } from "./page-hero"

/*
 * Polar's feature page, as a template: a split hero with a line drawing on
 * the right, numbered chapters with a sticky label, the details as hairline
 * rows, a strip of cards, and the rest of the product one click away. Every
 * product page is this file and a record in lib/pages.ts.
 */
export function ProductPageView({ slug, page }: { slug: string; page: ProductPage }) {
  const hue = `var(--hue-${page.hue})`
  const others = productNav.filter((p) => p.href !== `/${slug}`)

  return (
    <>
      <PageHero
        eyebrow={page.eyebrow}
        color={hue}
        title={page.title}
        lede={page.lede}
        aside={
          <div className="relative aspect-[5/4] overflow-hidden rounded-[24px] bg-surface-1 shadow-[inset_0_0_0_1px_var(--line)]">
            <LineGraphic variant={page.graphic} accent={hue} className="absolute inset-0 size-full" />
            <div className="absolute top-5 left-5 flex items-center gap-3">
              <IconTile icon={page.icon} hue={page.hue} />
              <span className="text-[14px] font-[540] text-fg">{page.title}</span>
            </div>
            <span className="absolute right-5 bottom-5 font-mono text-[11px] text-fg-4">i10.tech/{slug}</span>
          </div>
        }
      >
        <div data-reveal data-reveal-delay="0.25" className="mt-9 flex flex-wrap gap-3">
          <ButtonLink href={hosts.signIn} size="lg" arrow>
            Start sending
          </ButtonLink>
          <ButtonLink href={hosts.docs} size="lg" variant="secondary">
            Read the docs
          </ButtonLink>
        </div>
      </PageHero>

      <Frame className="py-8 md:py-12">
        {page.chapters.map((chapter, i) => (
          <div
            key={chapter.label}
            className="grid gap-6 border-line-faint py-16 not-first:border-t md:py-20 lg:grid-cols-[240px_1fr] lg:gap-16"
          >
            <div className="lg:sticky lg:top-[calc(var(--nav-h)+2.5rem)] lg:self-start">
              <span data-reveal className="type-label flex items-center gap-3 text-fg-4">
                <span className="tabular-nums" style={{ color: hue }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                {chapter.label}
              </span>
            </div>
            <div>
              <SplitReveal as="h2" className="type-display-m max-w-[18ch]">
                {chapter.title}
                <span className="text-fg-3"> {chapter.muted}</span>
              </SplitReveal>
              <p data-reveal className="type-lead mt-6 max-w-[40rem]">
                {chapter.body}
              </p>
            </div>
          </div>
        ))}
      </Frame>

      <Frame className="py-24">
        <div className="grid gap-12 lg:grid-cols-[240px_1fr] lg:gap-16">
          <SectionHeader title="In the box." size="s" />
          <dl data-reveal className="grid sm:grid-cols-2 sm:gap-x-10">
            {page.terms.map((t) => (
              <div key={t.term} className="border-t border-line py-6">
                <dt className="text-[15px] font-[540] tracking-[-0.01em] text-fg">{t.term}</dt>
                <dd className="mt-2 max-w-[32rem] text-[14px] leading-[22px] text-fg-3">{t.body}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div
          data-reveal
          className="mt-16 grid gap-px overflow-hidden rounded-[18px] bg-line shadow-[0_0_0_1px_var(--line)] sm:grid-cols-2 lg:grid-cols-4"
        >
          {page.cards.map((c) => (
            <div key={c.title} className="flex min-h-[148px] flex-col bg-canvas p-6">
              <span className="font-mono text-[12.5px] text-fg">{c.title}</span>
              <span className="mt-auto pt-6 text-[13.5px] leading-[21px] text-fg-3">{c.body}</span>
            </div>
          ))}
        </div>
      </Frame>

      <Frame className="py-24">
        <div className="flex items-end justify-between gap-6">
          <h2 data-reveal className="type-display-s">
            The rest of i10
          </h2>
          <Link data-reveal href="/pricing" className="group/btn inline-flex items-center gap-1.5 text-[14px] text-fg-2 transition-colors hover:text-fg">
            Pricing <Arrow />
          </Link>
        </div>
        <div data-reveal className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {others.slice(0, 4).map((p) => (
            <Link
                key={p.href}
                href={p.href}
                className="group flex flex-col gap-5 rounded-[16px] bg-surface-1 p-5 shadow-[inset_0_0_0_1px_var(--line)] transition-[background-color,box-shadow] duration-300 hover:bg-surface-2 hover:shadow-[inset_0_0_0_1px_var(--line-strong)]"
              >
                <span className="flex items-center justify-between">
                  {p.icon ? <IconTile icon={p.icon} hue={p.hue} /> : null}
                  {p.badge ? <Badge kind={p.badge} /> : null}
                </span>
                <span>
                  <span className="block text-[14.5px] font-[540] text-fg">{p.title}</span>
                  <span className="mt-1 block text-[13px] leading-5 text-fg-3">{p.description}</span>
                </span>
              </Link>
          ))}
        </div>
      </Frame>

      <Closing />
    </>
  )
}
