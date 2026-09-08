import { NewSignIn } from "../src/templates/new-sign-in"

export default function Preview() {
  return (
    <NewSignIn
      signInMethod="Password"
      device="Desktop · Chrome · macOS"
      location="Cairo, Egypt"
      ipAddress="102.44.18.7"
      signedInAt="9 September 2026 at 14:02"
      revokeUrl="https://auth.i10.tech/revoke?session=sample"
      supportEmail="support@i10.tech"
    />
  )
}
