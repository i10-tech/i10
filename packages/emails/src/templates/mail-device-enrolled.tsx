import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * Sent to the mailbox owner right after an Apple device finishes over-the-air
 * enrollment (#383 PR 4, docs/research/mail-device-binding.md section 12,
 * Review 1 H2). Makes a stolen enrollment link immediately visible and one tap
 * from revocation.
 */
export const mailDeviceEnrolledSubject = (model: string) =>
  `New mail device added (${model})`

export default function MailDeviceEnrolled({
  email,
  model,
  serialLast4,
  url,
}: {
  email: string
  model: string
  serialLast4: string
  url: string
}) {
  const title = mailDeviceEnrolledSubject(model)
  return (
    <Layout preview={title}>
      <Text style={styles.heading}>{title}</Text>
      <Text style={styles.text}>
        A new device ({model}, serial ending in {serialLast4}) was just enrolled for{" "}
        {email}.
      </Text>
      <Text style={styles.text}>
        If you did not enroll this device, revoke it immediately on your mail devices
        page.
      </Text>
      <ActionButton href={url}>Review mail devices</ActionButton>
      <FallbackLink href={url} />
    </Layout>
  )
}

MailDeviceEnrolled.PreviewProps = {
  email: "ada@acme.com",
  model: "iPhone16,2",
  serialLast4: "9X4K",
  url: "https://dash.i10.tech/account#mail-devices",
} satisfies React.ComponentProps<typeof MailDeviceEnrolled>
