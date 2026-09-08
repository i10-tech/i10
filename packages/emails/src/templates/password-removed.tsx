import { Text } from "@react-email/components"
import { Layout, styles } from "../layout.js"

/**
 * ⚠ THIS ONE MATTERS MORE THAN IT LOOKS. A mailbox holder signs in to IMAP with
 * this password — authd delegates the bind to Clerk — so removing it does not
 * merely change how they log in to the dashboard, it stops their mail client
 * working. The copy says so, because the generic Clerk wording does not.
 */
export default function PasswordRemoved({
  greetingName,
  emailAddress,
}: {
  greetingName?: string
  emailAddress?: string
}) {
  return (
    <Layout preview="Your i10 password was removed">
      <Text style={styles.heading}>Password removed</Text>
      {greetingName ? <Text style={styles.text}>Hi {greetingName},</Text> : null}
      <Text style={styles.text}>
        The password for {emailAddress ?? "your i10 account"} has been removed.
      </Text>
      <Text style={styles.text}>
        If you have an i10 mailbox, your mail client signs in with that password and
        will stop connecting until you set a new one.
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
PasswordRemoved.PreviewProps = {
  greetingName: "Mohamed",
  emailAddress: "mo@i10.tech",
} satisfies React.ComponentProps<typeof PasswordRemoved>
