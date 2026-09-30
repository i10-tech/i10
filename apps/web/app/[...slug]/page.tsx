import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { BrandPageView } from "@/components/pages/brand-page"
import { ChangelogList } from "@/components/pages/changelog-list"
import { ComparePageView } from "@/components/pages/compare-page"
import { LegalPageView } from "@/components/pages/legal-page"
import { MigratePageView } from "@/components/pages/migrate-page"
import { PageHero } from "@/components/pages/page-hero"
import { ProductPageView } from "@/components/pages/product-page"
import { SimplePageView } from "@/components/pages/simple-page"
import { StatusBoard } from "@/components/pages/status-board"
import { Frame } from "@/components/site/section"
import { PAGES, pageSlugs } from "@/lib/pages"

/*
 * Every secondary page, from one registry (lib/pages.ts). Only registered
 * paths are built; `dynamicParams = false` sends anything else to the bounce
 * notice in app/not-found.tsx instead of rendering an empty template.
 */
export const dynamicParams = false

export function generateStaticParams() {
  return pageSlugs().map((key) => ({ slug: key.split("/") }))
}

type Props = { params: Promise<{ slug: string[] }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const page = PAGES[slug.join("/")]
  if (!page) return {}
  return { title: page.title, description: page.lede }
}

export default async function Page({ params }: Props) {
  const { slug: parts } = await params
  const slug = parts.join("/")
  const page = PAGES[slug]
  if (!page) notFound()

  switch (page.kind) {
    case "product":
      return <ProductPageView slug={slug} page={page} />
    case "legal":
      return <LegalPageView slug={slug} page={page} />
    case "compare":
      return <ComparePageView slug={slug} page={page} />
    case "simple":
      return <SimplePageView page={page} />
    case "migrate":
      return <MigratePageView page={page} />
    case "brand":
      return <BrandPageView page={page} />
    case "changelog":
      return (
        <>
          <PageHero eyebrow={page.eyebrow} title={page.title} lede={page.lede} />
          <Frame className="py-16 md:py-20">
            <ChangelogList />
          </Frame>
        </>
      )
    case "status":
      return (
        <>
          <PageHero eyebrow={page.eyebrow} title={page.title} lede={page.lede} color="var(--state-delivered)" />
          <Frame className="py-16 md:py-20">
            <StatusBoard />
          </Frame>
        </>
      )
  }
}
