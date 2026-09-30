"use client"

import { motion, useSpring, useTransform } from "motion/react"
import { useEffect, useState, type CSSProperties } from "react"
import { cn } from "cn"
import { ButtonLink } from "@/components/ui/button-link"
import { plansFor, STOPS, type Product } from "@/lib/pricing"

/*
 * Resend's pricing selector, rebuilt: a product toggle, a volume slider with
 * labelled stops, and plan cards that re-price as the slider moves. The
 * "Recommended" frame is one element with a shared layout id, so it glides
 * from card to card instead of blinking between them.
 */
export function PricingPlans() {
  const [product, setProduct] = useState<Product>("transactional")
  const [stop, setStop] = useState(1)
  const stops = STOPS[product]
  const { plans, recommended } = plansFor(product, stop)

  const switchProduct = (p: Product) => {
    setProduct(p)
    setStop(1)
  }

  return (
    <div className="flex flex-col items-center">
      <div role="tablist" aria-label="Product" className="relative flex rounded-full bg-surface-2 p-1 shadow-[inset_0_0_0_1px_var(--line)]">
        {(["transactional", "marketing"] as const).map((p) => (
          <button
            key={p}
            role="tab"
            aria-selected={product === p}
            onClick={() => switchProduct(p)}
            className={cn("relative h-9 cursor-pointer rounded-full px-5 text-[13.5px] transition-colors", product === p ? "text-fg" : "text-fg-3 hover:text-fg-2")}
          >
            {product === p ? (
              <motion.span layoutId="product-pill" className="absolute inset-0 rounded-full bg-surface-4 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]" transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }} />
            ) : null}
            <span className="relative">{p === "transactional" ? "Transactional" : "Marketing"}</span>
          </button>
        ))}
      </div>

      <VolumeSlider
        label={product === "transactional" ? "Emails per month" : "Contacts"}
        stops={stops}
        value={stop}
        onChange={setStop}
      />

      <div className={cn("mt-14 grid w-full gap-3 text-left", plans.length === 4 ? "md:grid-cols-2 xl:grid-cols-4" : "md:grid-cols-3")}>
        {plans.map((plan) => {
          const isRec = plan.id === recommended
          return (
            <div key={plan.id} className="relative flex flex-col rounded-[20px] bg-surface-1 p-6 shadow-[inset_0_0_0_1px_var(--line)]">
              {isRec ? (
                <motion.span
                  layoutId="recommended"
                  aria-hidden
                  className="pointer-events-none absolute -inset-px rounded-[21px] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--brand)_55%,transparent),0_0_60px_-20px_color-mix(in_oklch,var(--brand)_45%,transparent)]"
                  transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
                />
              ) : null}
              <div className="flex h-6 items-center justify-between">
                <span className="text-[14px] font-[540] text-fg">{plan.name}</span>
                <span
                  className={cn(
                    "rounded-full bg-brand px-2 py-[3px] font-mono text-[9.5px] leading-none font-semibold tracking-[0.08em] text-brand-ink uppercase transition-[opacity,transform] duration-300",
                    isRec ? "opacity-100" : "scale-90 opacity-0",
                  )}
                >
                  Recommended
                </span>
              </div>
              <div className="mt-8 flex items-baseline gap-1.5">
                {plan.price === null ? (
                  <span className="type-display-s">Custom</span>
                ) : (
                  <>
                    <span className="type-display-s">
                      $<Price value={plan.price} />
                    </span>
                    <span className="text-[13px] text-fg-3">{plan.unit}</span>
                  </>
                )}
              </div>
              <p className="mt-3 min-h-[40px] text-[13px] leading-5 text-fg-2">
                {plan.allowance}
                {plan.overage ? <span className="block text-fg-4">{plan.overage}</span> : null}
              </p>
              <div className="my-6 h-px bg-line" />
              <ul className="flex flex-col gap-2.5">
                {plan.features.map((f) => (
                  <li key={f.text} className={cn("flex items-start gap-2.5 text-[13px] leading-5", f.included ? "text-fg-2" : "text-fg-4")}>
                    {f.included ? (
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className="mt-[3px] shrink-0 text-delivered">
                        <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className="mt-[3px] shrink-0 text-fg-4">
                        <path d="m5 5 6 6m0-6-6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    )}
                    {f.text}
                  </li>
                ))}
              </ul>
              <ButtonLink href={plan.href} variant={isRec ? "primary" : "secondary"} className="mt-8 w-full">
                {plan.cta}
              </ButtonLink>
            </div>
          )
        })}
      </div>
      <p className="mt-6 font-mono text-[11px] text-fg-4">Prices in USD, billed monthly. Placeholder pricing while i10 finalises its plans.</p>
    </div>
  )
}

/* The price counts to its new value on a spring instead of swapping digits. */
function Price({ value }: { value: number }) {
  const spring = useSpring(value, { stiffness: 170, damping: 26 })
  const display = useTransform(spring, (v) => Math.round(v).toLocaleString("en-US"))
  useEffect(() => {
    spring.set(value)
  }, [spring, value])
  return <motion.span>{display}</motion.span>
}

/* "1,500,000" -> "1.5M", "200,000+" -> "200k+": the tick labels on a phone. */
const shortLabel = ({ label, value }: { label: string; value: number }) =>
  (value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : `${value / 1_000}k`) + (label.endsWith("+") ? "+" : "")

/*
 * A native range input under the paint, so keyboard, touch and screen readers
 * all work the way they already know; the track fill and the labels are ours.
 * The labels are buttons too (Autumn does this): click a stop to jump to it.
 *
 * The end labels align to the track's ends rather than centring on their
 * stop, so neither can hang past the edge of the page on a phone.
 */
function VolumeSlider({
  label,
  stops,
  value,
  onChange,
}: {
  label: string
  stops: { label: string; value: number }[]
  value: number
  onChange: (v: number) => void
}) {
  const progress = value / (stops.length - 1)
  const last = stops.length - 1
  return (
    <div className="mt-14 w-full max-w-[760px]">
      <div className="flex items-end justify-between">
        <span className="type-label text-fg-4">{label}</span>
        <span className="font-display text-[22px] font-[560] tracking-[-0.03em] text-fg tabular-nums">{stops[value]?.label}</span>
      </div>
      <div className="relative mt-5">
        <input
          type="range"
          min={0}
          max={stops.length - 1}
          step={1}
          value={value}
          aria-label={label}
          aria-valuetext={stops[value]?.label}
          onChange={(e) => onChange(Number(e.target.value))}
          className="volume-range w-full"
          style={{ "--p": progress } as CSSProperties}
        />
        <div className="relative mt-3 h-5">
          {stops.map((s, i) => (
            <button
              key={s.label}
              type="button"
              aria-label={s.label}
              onClick={() => onChange(i)}
              className={cn(
                "absolute top-0 cursor-pointer font-mono text-[10.5px] whitespace-nowrap transition-colors",
                i === value ? "text-fg" : "text-fg-4 hover:text-fg-2",
              )}
              style={
                i === 0
                  ? { left: 0 }
                  : i === last
                    ? { right: 0 }
                    : { left: `calc(10px + ${i / last} * (100% - 20px))`, transform: "translateX(-50%)" }
              }
            >
              <span className="sm:hidden">{shortLabel(s)}</span>
              <span className="max-sm:hidden">{s.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
