import { Text } from "@react-email/components"
import { Layout, Provenance, styles } from "../layout.js"

/**
 * Two-factor authentication was turned on.
 *
 * ⚠ THIS IS THE ONE SECURITY NOTICE THAT IS USUALLY GOOD NEWS, and the copy
 * says so rather than leading with alarm. Every other message in this group
 * reports something being removed or changed; leading this one the same way
 * trains people to skim past the ones that matter.
 */
export default function MfaEnabled({
  greetingName,
  emailAddress,
  requestedFrom,
  requestedAt,
}: {
  greetingName?: string
  emailAddress?: string
  requestedFrom?: string
  requestedAt?: string
}) {
  return (
    <Layout preview="Two-step verification is on for your i10 account">
      <Text style={styles.heading}>Two-step verification enabled</Text>
      {greetingName ? <Text style={styles.text}>Hi {greetingName},</Text> : null}
      <Text style={styles.text}>
        Two-step verification is now switched on for{" "}
        {emailAddress ?? "your i10 account"}. You will be asked for a second factor when
        you sign in.
      </Text>
      <Provenance from={requestedFrom} at={requestedAt} />
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
MfaEnabled.PreviewProps = {
  greetingName: "Mohamed",
  emailAddress: "mo@i10.tech",
  requestedFrom: "Chrome on macOS",
  requestedAt: "9 September 2026 at 14:02",
} satisfies React.ComponentProps<typeof MfaEnabled>
