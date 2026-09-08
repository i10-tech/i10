import { Section, Text } from "@react-email/components"
import { ActionButton, Detail, Layout, styles } from "../../layout.js"

/**
 * ⚠ THIS ONE HAS A NOTICE PERIOD BAKED INTO ITS PURPOSE. A price change mail
 * sent on the day it takes effect is not a notice, it is an invoice surprise —
 * `effectiveFrom` is required rather than optional so a caller cannot send one
 * without saying when it starts.
 */
export function SubscriptionPriceChanged({
  planName,
  currentAmount,
  newAmount,
  effectiveFrom,
  billingUrl,
}: {
  planName?: string
  currentAmount: string
  newAmount: string
  effectiveFrom: string
  billingUrl?: string
}) {
  return (
    <Layout preview="Your i10 price is changing">
      <Text style={styles.heading}>Your price is changing</Text>
      <Text style={styles.text}>
        The price of {planName ?? "your i10 plan"} is changing from {effectiveFrom}.
      </Text>
      <Section style={{ margin: "16px 0" }}>
        <Detail label="Now" value={currentAmount} />
        <Detail label="From that date" value={newAmount} />
      </Section>
      <Text style={styles.text}>
        You do not need to do anything. If you would rather change or cancel your plan,
        you can do that before the new price starts.
      </Text>
      {billingUrl ? (
        <ActionButton href={billingUrl}>Manage your plan</ActionButton>
      ) : null}
    </Layout>
  )
}
