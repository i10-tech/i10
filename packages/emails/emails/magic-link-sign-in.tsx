import { MagicLink } from "../src/templates/magic-link"

export default function Preview() {
  return (
    <MagicLink
      purpose="sign-in"
      url="https://auth.i10.tech/verify?token=sample"
      ttlMinutes="10"
      requestedFrom="Chrome on macOS"
      requestedAt="9 September 2026 at 14:02"
    />
  )
}
