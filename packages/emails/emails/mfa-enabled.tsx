import { MfaEnabled } from "../src/templates/mfa-enabled"

export default function Preview() {
  return (
    <MfaEnabled
      greetingName="Mohamed"
      emailAddress="mo@i10.tech"
      requestedFrom="Chrome on macOS"
      requestedAt="9 September 2026 at 14:02"
    />
  )
}
