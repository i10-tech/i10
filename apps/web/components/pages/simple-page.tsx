import Link from "next/link"
import { cn } from "cn"
import { Closing } from "@/components/home/closing"
import { Frame } from "@/components/site/section"
import { ArrowUpRight } from "@/components/ui/button-link"
import type { SimplePage } from "@/lib/pages"
import { PageHero } from "./page-hero"

/*
 * Company and resource pages: a hero and a set of blocks, either as hairline
 * rows (Linear's about page reads like a list) or as cards. A block with an
 * href becomes a link and gets the corner arrow.
 */
export function SimplePageView({ page }: { page: SimplePage }) {
  const grid = page.variant === "grid"

  return (
    <>
      <PageHero eyebrow={page.eyebrow} title={page.title} lede={page.lede} />

      <Frame className="py-20 md:py-24">
        {grid ? (
          <div data-reveal className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {page.blocks.map((b) => (
              <Block
                key={b.title}
                block={b}
                className="rounded-[18px] bg-surface-1 p-6 shadow-[inset_0_0_0_1px_var(--line)]"
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col">
            {page.blocks.map((b) => (
              <div
                key={b.title}
                data-reveal
                className="grid gap-3 border-t border-line py-8 last:border-b md:grid-cols-[1fr_1.3fr] md:gap-12"
              >
                <div>
                  <p className="text-[18px] leading-7 font-[560] tracking-[-0.015em] text-fg">
                    {b.title}
                  </p>
                  {b.meta ? (
                    <p className="mt-1.5 font-mono text-[11.5px] text-fg-4">{b.meta}</p>
                  ) : null}
                </div>
                <p className="text-[15px] leading-[25px] text-fg-3">{b.body}</p>
              </div>
            ))}
          </div>
        )}
      </Frame>

      <Closing />
    </>
  )
}

function Block({
  block,
  className,
}: {
  block: SimplePage["blocks"][number]
  className?: string
}) {
  const inner = (
    <>
      <span className="flex items-start justify-between gap-4">
        <span className="text-[16px] leading-6 font-[560] tracking-[-0.01em] text-fg">
          {block.title}
        </span>
        {block.href ? (
          <ArrowUpRight className="mt-1 shrink-0 text-fg-4 transition-[color,transform] duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg" />
        ) : null}
      </span>
      {block.meta ? (
        <span className="mt-1.5 block font-mono text-[11.5px] text-fg-4">
          {block.meta}
        </span>
      ) : null}
      <span className="mt-8 block text-[14px] leading-[22px] text-fg-3">
        {block.body}
      </span>
    </>
  )
  if (block.href)
    return (
      <Link
        href={block.href}
        className={cn(
          "group flex flex-col transition-[background-color,box-shadow] duration-300 hover:bg-surface-2 hover:shadow-[inset_0_0_0_1px_var(--line-strong)]",
          className,
        )}
      >
        {inner}
      </Link>
    )
  return <div className={cn("flex flex-col", className)}>{inner}</div>
}
