import { Section, Text } from "@react-email/components"
import { Detail, Layout, styles } from "../layout.js"

export default function AccountLocked({
  lockedAt,
  failedAttempts,
  lockoutDuration,
}: {
  lockedAt?: string
  failedAttempts?: string
  lockoutDuration?: string
}) {
  return (
    <Layout preview="Your i10 account has been locked">
      <Text style={styles.heading}>Account locked</Text>
      <Text style={styles.text}>
        Your account has been locked. To protect it, access is temporarily restricted.
      </Text>
      <Section style={{ margin: "16px 0" }}>
        {lockedAt ? <Detail label="Locked on" value={lockedAt} /> : null}
        {failedAttempts ? (
          <Detail label="Failed attempts" value={failedAttempts} />
        ) : null}
      </Section>
      <Text style={styles.text}>
        {lockoutDuration
          ? `It unlocks automatically after ${lockoutDuration}.`
          : "It unlocks automatically after a short wait."}{" "}
        If you were not expecting this, someone may be trying to sign in as you — change
        your password once you can.
      </Text>
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
AccountLocked.PreviewProps = {
  lockedAt: "9 September 2026 at 14:02",
  failedAttempts: "5",
  lockoutDuration: "30 minutes",
} satisfies React.ComponentProps<typeof AccountLocked>
