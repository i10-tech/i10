import { PaymentSucceeded } from "../src/templates/billing/payment-succeeded"

export default function Preview() {
  return (
    <PaymentSucceeded
      amount="$20.00"
      planName="Pro"
      paidAt="9 September 2026"
      invoiceUrl="https://dash.i10.tech/billing"
    />
  )
}
