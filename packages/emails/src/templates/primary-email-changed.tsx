import { Text } from "@react-email/components"
import { Layout, styles } from "../layout.js"

export default function PrimaryEmailChanged({
  newEmailAddress,
}: {
  newEmailAddress?: string
}) {
  return (
    <Layout preview="Your i10 primary email address was updated">
      <Text style={styles.heading}>Email address updated</Text>
      <Text style={styles.text}>
        The primary email address for your account is now{" "}
        <b>{newEmailAddress ?? "a new address"}</b>. It is where account and recovery
        mail will be sent from now on.
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
PrimaryEmailChanged.PreviewProps = {
  newEmailAddress: "mo@i10.tech",
} satisfies React.ComponentProps<typeof PrimaryEmailChanged>
