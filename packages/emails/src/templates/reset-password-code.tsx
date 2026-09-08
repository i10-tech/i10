import { Text } from "@react-email/components"
import { Code, Layout, Provenance, styles } from "../layout.js"

export default function ResetPasswordCode({
  code,
  requestedFrom,
  requestedAt,
}: {
  code: string
  requestedFrom?: string
  requestedAt?: string
}) {
  return (
    <Layout preview="Your i10 password reset code">
      <Text style={styles.heading}>Reset password code</Text>
      <Text style={styles.text}>Enter this code when prompted:</Text>
      <Code code={code} />
      <Text style={styles.text}>
        To protect your account, do not share this code with anyone.
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
ResetPasswordCode.PreviewProps = {
  code: "384021",
  requestedFrom: "Safari on iPhone",
  requestedAt: "9 September 2026 at 14:02",
} satisfies React.ComponentProps<typeof ResetPasswordCode>
