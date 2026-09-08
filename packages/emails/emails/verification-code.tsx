import { VerificationCode } from "../src/templates/verification-code"

export default function Preview() {
  return (
    <VerificationCode
      code="384021"
      requestedFrom="Chrome on macOS"
      requestedAt="9 September 2026 at 14:02"
    />
  )
}
