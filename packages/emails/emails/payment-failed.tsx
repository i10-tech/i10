import { PaymentFailed } from "../src/templates/billing/payment-failed"

export default function Preview() {
  return (
    <PaymentFailed
      amount="$20.00"
      planName="Pro"
      reason="Card declined"
      retryAt="12 September 2026"
      billingUrl="https://dash.i10.tech/billing"
    />
  )
}
