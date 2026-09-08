import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Preview,
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
