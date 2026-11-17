import Link from "next/link"
import { cn } from "cn"
import { Frame } from "@/components/site/section"
import { PAGES, type DocPage, type DocTable } from "@/lib/pages"
import { DocToc } from "./doc-toc"
import { PageHero } from "./page-hero"

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")

/* A legal document: a sticky table of contents and a readable measure. */
export function LegalPageView({ slug, page }: { slug: string; page: DocPage }) {
  const items = page.sections.map((s) => ({ id: slugify(s.title), title: s.title }))
  const siblings = Object.entries(PAGES).filter(
    ([key, p]) => p.kind === "legal" && key !== slug,
  )

  return (
    <>
      <PageHero eyebrow="Legal" title={page.title} lede={page.lede}>
        <p
          data-reveal
          data-reveal-delay="0.25"
          className="mt-8 font-mono text-[11.5px] text-fg-4"
        >
          Last updated {page.updated}
        </p>
      </PageHero>

      <Frame className="py-16 md:py-20">
        <div className="grid gap-12 lg:grid-cols-[220px_1fr] lg:gap-20">
          <aside className="max-lg:hidden">
            <div className="sticky top-[calc(var(--nav-h)+2.5rem)] flex flex-col gap-10">
              <DocToc items={items} />
              <div className="flex flex-col">
                <span className="type-label mb-4 text-fg-4">Legal</span>
                {siblings.map(([key, p]) => (
                  <Link
                    key={key}
                    href={`/${key}`}
                    className="py-1.5 text-[13px] text-fg-3 transition-colors hover:text-fg"
                  >
                    {p.title}
                  </Link>
                ))}
              </div>
            </div>
          </aside>

          <article className="max-w-[44rem]">
            {page.sections.map((section, i) => (
              <section
                key={section.title}
                id={items[i]?.id}
                className={cn("scroll-mt-[calc(var(--nav-h)+2rem)]", i > 0 && "mt-12")}
              >
                <h2
                  data-reveal
                  className="flex items-baseline gap-3 text-[21px] leading-7 font-[560] tracking-[-0.02em] text-fg"
                >
                  <span className="font-mono text-[12px] font-normal text-fg-4 tabular-nums">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {section.title}
                </h2>
                {section.paragraphs.map((para) => (
                  <p key={para} className="mt-4 text-[15px] leading-[26px] text-fg-2">
                    {para}
                  </p>
                ))}
                {section.table && <SectionTable table={section.table} />}
                {section.after?.map((para) => (
                  <p key={para} className="mt-4 text-[15px] leading-[26px] text-fg-2">
                    {para}
                  </p>
                ))}
              </section>
            ))}
          </article>
        </div>
      </Frame>
    </>
  )
}

/* Scrolls sideways on a narrow screen, so no column is squeezed unreadable. */
function SectionTable({ table }: { table: DocTable }) {
  return (
    <div data-reveal className="mt-6 overflow-x-auto rounded-[14px] border border-line">
      <table className="w-full min-w-[640px] border-collapse text-left text-[13.5px] leading-[21px]">
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th key={column} scope="col" className="type-label px-4 py-3 text-fg-4">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row[0]} className="border-t border-line align-top">
              {row.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="px-4 py-3.5 font-[540] text-fg">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className="px-4 py-3.5 text-fg-2">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
