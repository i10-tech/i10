import { Section, Text } from "@react-email/components"
import { ActionButton, Detail, Layout, styles } from "../../layout.js"

/*
 * Billing mail.
 *
 * ⚠ THESE THREE ARE NOT WIRED TO ANYTHING, AND NOT TO CLERK AT ALL. Clerk has
 * its own billing product and emits `paymentAttempt.*` webhooks for it; i10
 * does not use it — Polar takes the money and `packages/metering` counts the
 * usage. So these are driven from OUR events when that lands, and the props are
 * shaped after what Polar and the meter actually know rather than after Clerk's
 * template variables. Wiring them to Clerk's billing events would be wiring
 * them to a system we have deliberately not bought.
 *
 * ⚠ AND NONE OF THEM IS AN INVOICE. An invoice is a tax document with legal
 * requirements that vary by country; these are notifications that point at one.
 */
export function PaymentSucceeded({
  amount,
  planName,
  paidAt,
  invoiceUrl,
}: {
  /** Already formatted with its currency — see the note in the registry. */
  amount: string
  planName?: string
  paidAt?: string
  invoiceUrl?: string
}) {
  return (
    <Layout preview="Your i10 payment went through">
      <Text style={styles.heading}>Payment received</Text>
      <Text style={styles.text}>
        Thanks — your payment for {planName ?? "i10"} has gone through.
      </Text>
      <Section style={{ margin: "16px 0" }}>
        <Detail label="Amount" value={amount} />
        {planName ? <Detail label="Plan" value={planName} /> : null}
        {paidAt ? <Detail label="Paid on" value={paidAt} /> : null}
      </Section>
      {invoiceUrl ? <ActionButton href={invoiceUrl}>View invoice</ActionButton> : null}
    </Layout>
  )
}
