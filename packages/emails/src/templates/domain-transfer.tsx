import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, styles } from "../layout.js"

/**
 * A domain offered to somebody by email.
 *
 * ⚠ TWO VERSIONS OF ONE SENTENCE, CHOSEN BY WHETHER THE ADDRESS HAS AN i10
 * ACCOUNT. Somebody without one has to sign up with THIS address before the
 * offer can be accepted — it is matched against the verified address, not
 * against whoever clicks — so the email says so before they click rather than
 * after they have signed up with a different one.
 */
export default function DomainTransfer({
  url,
  domain,
  offeredBy,
  fromWorkspace,
  hasAccount,
  expires,
}: {
  url: string
  domain: string
  offeredBy: string
  fromWorkspace: string
  hasAccount: boolean
  /** Already formatted, e.g. "3 October 2026". */
  expires: string
}) {
  return (
    <Layout preview={`${offeredBy} wants to transfer ${domain} to you`}>
      <Text style={styles.heading}>A domain is waiting for you</Text>
      <Text style={styles.text}>
        {offeredBy} wants to transfer <strong>{domain}</strong> from the {fromWorkspace}{" "}
        workspace to you on i10. It keeps its records and its verification, so nothing
        changes in its DNS.
      </Text>
      <Text style={styles.text}>
        {hasAccount
          ? "Sign in with this address to accept it and choose which workspace it goes into."
          : "Create your i10 account with this address first — the transfer can only be accepted by it — then choose which workspace the domain goes into."}
      </Text>
      <ActionButton href={url}>
        {hasAccount ? "Review the transfer" : "Sign up and accept"}
      </ActionButton>
      <FallbackLink href={url} />
      <Text style={styles.text}>
        The offer expires on {expires}. If you were not expecting it, ignore this email
        — nothing moves unless you accept.
      </Text>
    </Layout>
  )
}

DomainTransfer.PreviewProps = {
  url: "https://console.i10.tech/transfers/sample",
  domain: "example.com",
  offeredBy: "Mohamed",
  fromWorkspace: "Acme",
  hasAccount: false,
  expires: "3 October 2026",
} satisfies React.ComponentProps<typeof DomainTransfer>
