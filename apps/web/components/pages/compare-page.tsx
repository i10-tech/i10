import Link from "next/link"
import { cn } from "cn"
import { Closing } from "@/components/home/closing"
import { Frame } from "@/components/site/section"
import { ArrowUpRight, ButtonLink } from "@/components/ui/button-link"
import { PAGES, type ComparePage } from "@/lib/pages"
import { hosts } from "@/lib/site"
import { PageHero } from "./page-hero"

/*
 * i10 beside another provider. The i10 column is raised a surface and edged
 * in post yellow, so the eye lands on the answer without a tint muddying it.
 *
 * ⚠ A CELL WE HAVE NOT CHECKED SAYS SO. Anything about another provider that
 * has not been verified against its public docs reads "To verify" in muted
 * mono, never a guess dressed as a fact.
 */
function Cell({ value, strong }: { value: string; strong?: boolean }) {
  if (value === "Yes")
    return (
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        aria-label="Yes"
        className="text-delivered"
      >
        <path
          d="m3.5 8.5 3 3 6-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  if (value === "No")
    return (
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        aria-label="No"
        className="text-fg-4"
      >
        <path
          d="m5 5 6 6m0-6-6 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    )
  if (value === "To verify")
    return <span className="font-mono text-[11px] text-fg-4">To verify</span>
  return <span className={strong ? "text-fg" : "text-fg-2"}>{value}</span>
}

export function ComparePageView({ slug, page }: { slug: string; page: ComparePage }) {
  const others = Object.entries(PAGES).filter(
    ([key, p]) => p.kind === "compare" && key !== slug,
  )

  return (
    <>
      <PageHero eyebrow="Compare" title={page.title} lede={page.lede}>
        <div data-reveal data-reveal-delay="0.25" className="mt-9 flex flex-wrap gap-3">
          <ButtonLink href={hosts.signIn} size="lg" arrow>
            Start sending
          </ButtonLink>
          <ButtonLink href="/migrate/resend" size="lg" variant="secondary">
            Migration guide
          </ButtonLink>
        </div>
      </PageHero>

      <Frame className="py-20 md:py-24">
        <div data-reveal className="relative overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left text-[14px]">
            <thead>
              <tr>
                <th scope="col" className="w-[44%] pb-4 font-normal">
                  <span className="type-label text-fg-4">Feature</span>
                </th>
                <th
                  scope="col"
                  className="w-[28%] rounded-t-[14px] bg-surface-2 px-5 pt-5 pb-4 text-[14px] font-[560] text-fg shadow-[inset_0_2px_0_var(--brand)]"
                >
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="size-[5px] bg-brand" />
                    i10
                  </span>
                </th>
                <th
                  scope="col"
                  className="w-[28%] px-5 pt-5 pb-4 text-[14px] font-[560] text-fg-2"
                >
                  {page.them}
                </th>
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row, i) => (
                <tr key={row.label} className="border-t border-line">
                  <th scope="row" className="py-4 pr-4 font-normal text-fg-2">
                    {row.label}
                  </th>
                  <td
                    className={cn(
                      "bg-surface-2 px-5 py-4",
                      i === page.rows.length - 1 && "rounded-b-[14px]",
                    )}
                  >
                    <Cell value={row.i10} strong />
                  </td>
                  <td className="px-5 py-4">
                    <Cell value={row.them} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-6 font-mono text-[11px] text-fg-4">
          Draft comparison. Every cell is checked against the provider&apos;s public
          documentation before this page is published.
        </p>
      </Frame>

      {others.length ? (
        <Frame className="py-20">
          <span data-reveal className="type-label text-fg-4">
            Other comparisons
          </span>
          <div data-reveal className="mt-6 grid gap-3 sm:grid-cols-3">
            {others.map(([key, p]) => (
              <Link
                key={key}
                href={`/${key}`}
                className="group flex items-center justify-between rounded-[14px] bg-surface-1 px-5 py-4 text-[14px] text-fg-2 shadow-[inset_0_0_0_1px_var(--line)] transition-[background-color,color] duration-300 hover:bg-surface-2 hover:text-fg"
              >
                {p.title}
                <ArrowUpRight className="text-fg-4 transition-[color,transform] duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg" />
              </Link>
            ))}
          </div>
        </Frame>
      ) : null}

      <Closing />
    </>
  )
}
