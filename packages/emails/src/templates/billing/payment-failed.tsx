import { Section, Text } from "@react-email/components"
import { ActionButton, Detail, Layout, styles } from "../../layout.js"

/**
 * ⚠ IT SAYS WHAT STOPS WORKING AND WHEN, because that is the only part the
 * customer can act on. A failed-payment mail that says "please update your
 * card" without saying that mail stops sending on Friday gets ignored until the
 * sending stops, which is the expensive way for both sides to find out.
 */
export default function PaymentFailed({
  amount,
  planName,
  reason,
  retryAt,
  billingUrl,
}: {
  amount: string
  planName?: string
  reason?: string
  retryAt?: string
  billingUrl?: string
}) {
  return (
    <Layout preview="Your i10 payment did not go through">
      <Text style={styles.heading}>Payment failed</Text>
      <Text style={styles.text}>
        We could not take payment for {planName ?? "your i10 plan"}. Your account is
        still active for now.
      </Text>
      <Section style={{ margin: "16px 0" }}>
        <Detail label="Amount" value={amount} />
        {reason ? <Detail label="Reason" value={reason} /> : null}
        {retryAt ? <Detail label="Next attempt" value={retryAt} /> : null}
      </Section>
      <Text style={styles.text}>
        Update your payment details to avoid interruption — sending is paused once a
        plan lapses, and mailboxes stop accepting mail.
      </Text>
      {billingUrl ? (
        <ActionButton href={billingUrl}>Update payment details</ActionButton>
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
PaymentFailed.PreviewProps = {
  amount: "$20.00",
  planName: "Pro",
  reason: "Card declined",
  retryAt: "12 September 2026",
  billingUrl: "https://dash.i10.tech/billing",
} satisfies React.ComponentProps<typeof PaymentFailed>
