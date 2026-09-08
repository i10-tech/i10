import { AccountLocked } from "../src/templates/account-locked"

export default function Preview() {
  return (
    <AccountLocked
      lockedAt="9 September 2026 at 14:02"
      failedAttempts="5"
      lockoutDuration="30 minutes"
    />
  )
}
