import { Text } from "@react-email/components"
import { Layout, styles } from "../layout.js"

export default function WaitlistConfirmation() {
  return (
    <Layout preview="You're on the i10 waitlist">
      <Text style={styles.heading}>You&apos;re on the waitlist</Text>
      <Text style={styles.text}>
        You have joined the waitlist for i10. We will let you know as we open up access.
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
WaitlistConfirmation.PreviewProps = {} satisfies React.ComponentProps<
  typeof WaitlistConfirmation
>
