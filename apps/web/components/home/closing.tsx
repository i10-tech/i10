import Link from "next/link"
import { SplitReveal } from "@/components/motion/split-reveal"
import { Arrow } from "@/components/ui/button-link"
import { hosts } from "@/lib/site"

/*
 * The last word, on a post-yellow card inset from the page edges the way
 * Cloudflare frames its hero. The nav reads `data-nav-tone="brand"` and turns
 * its logo to ink while it passes over.
 */
export function Closing() {
  return (
    <section data-nav-tone="brand" className="relative px-2 pt-10 md:px-3">
      <div className="closing-card selection-ink relative overflow-hidden rounded-[28px] bg-brand text-brand-ink">
        <div aria-hidden className="closing-dots pointer-events-none absolute inset-0" />
        <div aria-hidden className="closing-glow pointer-events-none absolute" />
        <div className="container-site relative flex flex-col items-center py-24 text-center md:py-36">
          <p className="type-label text-brand-ink/60">3,000 emails a month, free · no card</p>
          <SplitReveal as="h2" className="type-display-l mt-6 max-w-[16ch] text-brand-ink">
            Send your first email in <span className="type-accent">two minutes.</span>
          </SplitReveal>
          <p data-reveal className="mt-6 max-w-[34rem] text-[17px] leading-[27px] text-brand-ink/70">
            One DNS record, one import, one call. The rest of i10 is there when you need it.
          </p>
          <div data-reveal className="mt-10 flex flex-wrap justify-center gap-3">
            <Link
              href={hosts.signIn}
              className="group/btn inline-flex h-12 items-center gap-2.5 rounded-full bg-brand-ink px-6 text-[15px] font-[540] text-fg transition-transform active:scale-[0.98]"
            >
              Start sending free <Arrow />
            </Link>
            <Link
              href="/pricing"
              className="inline-flex h-12 items-center rounded-full px-6 text-[15px] font-[540] text-brand-ink shadow-[inset_0_0_0_1.5px_rgb(11_11_12/0.25)] transition-colors hover:bg-brand-ink/[0.06]"
            >
              See pricing
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}
