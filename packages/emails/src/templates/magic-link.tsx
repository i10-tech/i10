import { Text } from "@react-email/components"
import { ActionButton, FallbackLink, Layout, Provenance, styles } from "../layout.js"

/**
 * The three email-link templates, which differ only in wording.
 *
 * ⚠ ONE COMPONENT FOR SIGN-IN, SIGN-UP AND VERIFY-ADDRESS, and that is a
 * judgement rather than laziness: Clerk ships them as three templates whose
 * bodies are identical apart from a verb, and three files here would be three
 * places to fix the same typo. The registry still maps three slugs, so they can
 * diverge later by taking this apart rather than by editing a shared file.
 */
export type MagicLinkPurpose = "sign-in" | "sign-up" | "verify"

const COPY: Record<MagicLinkPurpose, { heading: string; action: string }> = {
  "sign-in": { heading: "Sign in to i10", action: "Sign in" },
  "sign-up": { heading: "Sign up to i10", action: "Sign up" },
  verify: { heading: "Verify your email address", action: "Verify email address" },
}

export default function MagicLink({
  purpose,
  url,
  ttlMinutes,
  requestedFrom,
  requestedAt,
}: {
  purpose: MagicLinkPurpose
  url: string
  ttlMinutes?: string
  requestedFrom?: string
  requestedAt?: string
}) {
  const copy = COPY[purpose]

  return (
    <Layout preview={`${copy.heading} with this link`}>
      <Text style={styles.heading}>{copy.heading}</Text>
      <Text style={styles.text}>
        Use the button below to continue
        {ttlMinutes ? `. This link expires in ${ttlMinutes} minutes.` : "."}
      </Text>
      <ActionButton href={url}>{copy.action}</ActionButton>
      <FallbackLink href={url} />
      <Provenance from={requestedFrom} at={requestedAt} />
    </Layout>
  )
}

/*
 * ⚠ `PreviewProps` IS WHAT LETS THE TEMPLATE AND ITS PREVIEW BE ONE FILE.
 * `email dev` renders a directory of DEFAULT exports and has no way to invent
 * props, so this used to need a second `emails/` tree holding sample values —
 * two files per template, and a preview that could silently drift from what is
 * actually sent. react-email reads this static instead, so the thing you look
 * at IS the thing that goes out.
 *
 * It costs a few sample strings in the built bundle. Nothing reads them at
 * runtime; the alternative was a whole parallel directory.
 */
MagicLink.PreviewProps = {
  purpose: "sign-in",
  url: "https://auth.i10.tech/verify?token=sample",
  ttlMinutes: "10",
  requestedFrom: "Chrome on macOS",
  requestedAt: "9 September 2026 at 14:02",
} satisfies React.ComponentProps<typeof MagicLink>
