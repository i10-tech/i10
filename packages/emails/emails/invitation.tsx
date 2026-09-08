import { Invitation } from "../src/templates/invitation"

export default function Preview() {
  return (
    <Invitation url="https://auth.i10.tech/accept?ticket=sample" expiresInDays="7" />
  )
}
