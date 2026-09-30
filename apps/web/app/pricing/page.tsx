import type { Metadata } from "next"
import { Closing } from "@/components/home/closing"
import { SplitReveal } from "@/components/motion/split-reveal"
import { AddOns, CompareTable, Faq } from "@/components/pricing/pricing-sections"
import { PricingPlans } from "@/components/pricing/pricing-plans"
import { Frame, SectionHeader } from "@/components/site/section"

export const metadata: Metadata = {
  title: "Pricing",
  description: "Start free with 3,000 emails a month. Scale as you grow, and add real mailboxes when your team needs them.",
}

export default function PricingPage() {
  return (
    <>
      <section data-nav-tone="dark" className="relative overflow-hidden pt-[calc(var(--nav-h)+5rem)] pb-24">
        <div aria-hidden className="hero-grid pointer-events-none absolute inset-0" />
        <div className="container-site relative flex flex-col items-center text-center">
          <SplitReveal as="h1" mode="scatter" onScroll={false} className="type-display-xl">
            Pricing that <span className="type-accent">scales</span> with you.
          </SplitReveal>
          <p data-reveal className="type-lead mt-6 max-w-[34rem]">
            Start free and pay for what you send. Add mailboxes, domains and a dedicated IP when you need them, not before.
          </p>
          <div className="mt-4 w-full">
            <PricingPlans />
          </div>
        </div>
      </section>

      <Frame className="py-24">
        <SectionHeader title="Add-ons." muted="Only if you need them." size="s" />
        <div className="mt-10">
          <AddOns />
        </div>
      </Frame>

      <Frame className="py-24">
        <CompareTable />
      </Frame>

      <Frame className="py-24">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr]">
          <SectionHeader title="Questions," muted="answered." size="s" />
          <Faq />
        </div>
      </Frame>

      <Closing />
    </>
  )
}
