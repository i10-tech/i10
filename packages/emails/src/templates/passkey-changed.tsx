import { Text } from "@react-email/components"
import { Layout, styles } from "../layout.js"

/**
 * ⚠ ONE COMPONENT FOR ADDED AND REMOVED, because the two Clerk templates differ
 * by a single word and the security advice is identical. The registry maps both
 * slugs; splitting them later is a file move, not a rewrite.
 */
export default function PasskeyChanged({
  action,
  greetingName,
  emailAddress,
  passkeyName,
}: {
  action: "added" | "removed"
  greetingName?: string
  emailAddress?: string
  passkeyName?: string
}) {
  return (
    <Layout preview={`A passkey was ${action} on your i10 account`}>
      <Text style={styles.heading}>Passkey {action}</Text>
      {greetingName ? <Text style={styles.text}>Hi {greetingName},</Text> : null}
      <Text style={styles.text}>
        A passkey{passkeyName ? ` (${passkeyName})` : ""} for{" "}
        {emailAddress ?? "your account"} was {action}.
      </Text>
      <Text style={styles.text}>
        If this was not you, contact support straight away.
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
PasskeyChanged.PreviewProps = {
  action: "added",
  greetingName: "Mohamed",
  emailAddress: "mo@i10.tech",
  passkeyName: "iCloud Keychain",
} satisfies React.ComponentProps<typeof PasskeyChanged>
