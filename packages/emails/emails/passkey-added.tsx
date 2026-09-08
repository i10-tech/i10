import { PasskeyChanged } from "../src/templates/passkey-changed"

export default function Preview() {
  return (
    <PasskeyChanged
      action="added"
      greetingName="Mohamed"
      emailAddress="mo@i10.tech"
      passkeyName="iCloud Keychain"
    />
  )
}
