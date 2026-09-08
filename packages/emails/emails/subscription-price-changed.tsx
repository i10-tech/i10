import { SubscriptionPriceChanged } from "../src/templates/billing/subscription-price-changed"

export default function Preview() {
  return (
    <SubscriptionPriceChanged
      planName="Pro"
      currentAmount="$20.00 / month"
      newAmount="$24.00 / month"
      effectiveFrom="1 November 2026"
      billingUrl="https://dash.i10.tech/billing"
    />
  )
}
