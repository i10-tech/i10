import { Section, Text } from "@react-email/components"
import { ActionButton, Detail, Layout, styles } from "../../layout.js"

/**
 * ⚠ THIS ONE HAS A NOTICE PERIOD BAKED INTO ITS PURPOSE. A price change mail
 * sent on the day it takes effect is not a notice, it is an invoice surprise —
 * `effectiveFrom` is required rather than optional so a caller cannot send one
 * without saying when it starts.
 */
export default function SubscriptionPriceChanged({
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

/*
 * ⚠ `PreviewProps` IS WHAT LETS THE TEMPLATE AND ITS PREVIEW BE ONE FILE.
 * `email dev` renders a directory of DEFAULT exports and has no way to invent
 * props, so this used to need a second `emails/` tree holding sample values —
 * two files per template, and a preview that could silently drift from what is
 * actually sent. react-email reads this static instead, so the thing you look
 * at IS the thing that goes out.
 *
 * It costs a few sample strings in the built bundle. Nothing reads them at
 * runtime; the alternative was a whole parallel directory.
 */
SubscriptionPriceChanged.PreviewProps = {
  planName: "Pro",
  currentAmount: "$20.00 / month",
  newAmount: "$24.00 / month",
  effectiveFrom: "1 November 2026",
  billingUrl: "https://dash.i10.tech/billing",
} satisfies React.ComponentProps<typeof SubscriptionPriceChanged>
