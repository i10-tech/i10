import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components"

/**
 * The frame every i10 email is drawn in.
 *
 * ⚠ EVERY STYLE IS AN INLINE OBJECT, NOT A CLASS. Gmail strips <style> blocks
 * from the head, Outlook's rendering engine is Word, and neither supports the
 * cascade in any form worth relying on. This is the one place in the repo where
 * inline styles are correct rather than a shortcut — the token sheet and
 * Tailwind do not reach here at all.
 *
 * ⚠ AND IT IS LIGHT, WHILE THE PRODUCT IS DARK. That is deliberate: Gmail and
 * Outlook apply their OWN dark-mode transforms to a message, inverting some
 * colours and not others, and a design that starts dark comes out of that
 * process with grey text on a grey card. Starting light is the only version
 * that survives every client, and it is why the app's palette is not reused.
 *
 * ⚠ NO BRAND ACCENT. `--brand` is deliberately unset in the token sheet, and an
 * email is the worst place to invent one — it is the artifact a customer keeps,
 * forwards and screenshots. Neutrals only until somebody chooses.
 */

const font =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

export const styles = {
  body: {
    backgroundColor: "#f6f6f6",
    fontFamily: font,
    margin: 0,
    padding: "24px 0",
  },
  container: {
    backgroundColor: "#ffffff",
    border: "1px solid #e6e6e6",
    borderRadius: "10px",
    margin: "0 auto",
    maxWidth: "480px",
    padding: "32px",
  },
  wordmark: {
    color: "#0a0a0a",
    fontSize: "18px",
    fontWeight: 600,
    letterSpacing: "-0.01em",
    margin: "0 0 24px",
  },
  heading: {
    color: "#0a0a0a",
    fontSize: "20px",
    fontWeight: 600,
    lineHeight: "28px",
    margin: "0 0 12px",
  },
  text: {
    color: "#404040",
    fontSize: "14px",
    lineHeight: "22px",
    margin: "0 0 16px",
  },
  code: {
    backgroundColor: "#f4f4f4",
    borderRadius: "8px",
    color: "#0a0a0a",
    display: "block",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "28px",
    fontWeight: 600,
    letterSpacing: "0.2em",
    margin: "0 0 16px",
    padding: "16px",
    textAlign: "center" as const,
  },
  hr: { borderColor: "#e6e6e6", margin: "24px 0" },
  footer: { color: "#8a8a8a", fontSize: "12px", lineHeight: "18px", margin: 0 },
} as const

export function Layout({
  preview,
  children,
}: {
  /**
   * The line a mail client shows beside the subject.
   *
   * ⚠ NOT OPTIONAL, AND NOT THE SUBJECT REPEATED. Left out, clients fill it
   * with whatever text comes first — which for a code email is the code itself,
   * printed in the inbox list next to the subject where anyone glancing at the
   * screen can read it.
   */
  preview: string
  children: React.ReactNode
}) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.wordmark}>i10</Text>
          {children}
          <Hr style={styles.hr} />
          <Section>
            <Text style={styles.footer}>
              This message was sent by i10. If you were not expecting it, you can ignore
              it — no action is taken unless you act on it.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

/**
 * The one-time code, shown once and large.
 *
 * ⚠ SELECTABLE TEXT, NEVER AN IMAGE. A code rendered as an image cannot be
 * copied, cannot be read by a screen reader, and is hidden entirely by the
 * image blocking most clients apply by default — which would make the mail
 * arrive apparently empty.
 */
export function Code({ code }: { code: string }) {
  return <Text style={styles.code}>{code}</Text>
}

export const detail = {
  cell: {
    backgroundColor: "#fafafa",
    fontSize: "13px",
    padding: "8px 12px",
  },
  label: { color: "#8a8a8a", margin: 0 },
  value: { color: "#0a0a0a", fontWeight: 600, margin: 0 },
} as const

/**
 * The dark action button.
 *
 * ⚠ A TABLE UNDERNEATH, WHICH IS WHY IT IS A COMPONENT AND NOT AN <a>. Outlook
 * renders through Word and gives a styled anchor no padding and no background,
 * so the "button" arrives as bare blue underlined text. react-email's Button
 * emits the table-and-VML shape that survives it.
 */
export function ActionButton({ href, children }: { href: string; children: string }) {
  return (
    <Button
      href={href}
      style={{
        backgroundColor: "#131316",
        borderRadius: "6px",
        color: "#ffffff",
        display: "inline-block",
        fontSize: "13px",
        fontWeight: 600,
        margin: "24px 0 16px",
        padding: "10px 16px",
        textDecoration: "none",
      }}
    >
      {children}
    </Button>
  )
}

/**
 * ⚠ EVERY BUTTON GETS THIS UNDERNEATH. Corporate mail clients and link scanners
 * routinely mangle or strip the button's href, and a person who cannot click it
 * has no other way through — the plain link is the fallback that keeps the mail
 * usable rather than a courtesy.
 */
export function FallbackLink({ href }: { href: string }) {
  return (
    <Text style={styles.text}>
      If the button does not work,{" "}
      <Link href={href} style={{ color: "#131316", textDecoration: "underline" }}>
        use this link instead
      </Link>
      .
    </Text>
  )
}

/** One label/value row in a details block. */
export function Detail({ label, value }: { label: string; value: string }) {
  return (
    <Row>
      <Column style={{ ...detail.cell, width: "35%" }}>
        <Text style={detail.label}>{label}</Text>
      </Column>
      <Column style={{ ...detail.cell, width: "65%" }}>
        <Text style={detail.value}>{value}</Text>
      </Column>
    </Row>
  )
}

/**
 * "Didn't request this?" — the provenance footer on anything actionable.
 *
 * ⚠ IT NAMES THE DEVICE AND THE TIME, WHICH IS THE ONLY PART OF A PHISHING
 * DEFENCE A CUSTOMER CAN ACTUALLY USE. A code email that says nothing about
 * where it came from gives the recipient no way to tell a real one from a
 * forged one; "requested from Chrome on macOS at 14:02" does.
 */
export function Provenance({ from, at }: { from?: string; at?: string }) {
  if (!from && !at) return null

  return (
    <Section style={{ marginTop: "32px" }}>
      <Text style={{ ...styles.text, fontWeight: 600, marginBottom: "4px" }}>
        Didn&apos;t request this?
      </Text>
      <Text style={{ ...styles.text, margin: 0 }}>
        This was requested from {from ?? "an unknown device"}
        {at ? ` at ${at}` : ""}. If it was not you, you can ignore this message.
      </Text>
    </Section>
  )
}
