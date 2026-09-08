import { Section, Text } from "@react-email/components"
import { ActionButton, Detail, FallbackLink, Layout, styles } from "../layout.js"

/**
 * A new device signed in.
 *
 * ⚠ THE REVOKE BUTTON IS THE ONE ACTIONABLE LINK WE DO SEND, and it is safe
 * where a "reset your password" link would not be: the worst a stolen revoke
 * URL can do is sign somebody OUT. That asymmetry is the whole reason it is
 * allowed here — it fails closed.
 */
export default function NewSignIn({
  signInMethod,
  device,
  location,
  ipAddress,
  signedInAt,
  revokeUrl,
  supportEmail,
}: {
  signInMethod?: string
  device?: string
  location?: string
  ipAddress?: string
  signedInAt?: string
  revokeUrl?: string
  supportEmail?: string
}) {
  return (
    <Layout preview="New sign in to your i10 account">
      <Text style={styles.heading}>New sign in to your account</Text>
      <Text style={styles.text}>
        A new device just signed in to your i10 account. If you recognise it, there is
        nothing to do.
      </Text>
      <Section style={{ margin: "16px 0" }}>
        {signInMethod ? <Detail label="Sign in type" value={signInMethod} /> : null}
        {device ? <Detail label="Device" value={device} /> : null}
        {location ? <Detail label="Location" value={location} /> : null}
        {ipAddress ? <Detail label="IP" value={ipAddress} /> : null}
        {signedInAt ? <Detail label="Time" value={signedInAt} /> : null}
      </Section>
      {revokeUrl ? (
        <>
          <Text style={{ ...styles.text, fontWeight: 600 }}>
            Don&apos;t recognise this?
          </Text>
          <ActionButton href={revokeUrl}>Sign out of this device</ActionButton>
          <FallbackLink href={revokeUrl} />
        </>
      ) : null}
      {supportEmail ? (
        <Text style={styles.text}>Any questions, reach us at {supportEmail}.</Text>
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
NewSignIn.PreviewProps = {
  signInMethod: "Password",
  device: "Desktop · Chrome · macOS",
  location: "Cairo, Egypt",
  ipAddress: "102.44.18.7",
  signedInAt: "9 September 2026 at 14:02",
  revokeUrl: "https://auth.i10.tech/revoke?session=sample",
  supportEmail: "support@i10.tech",
} satisfies React.ComponentProps<typeof NewSignIn>
