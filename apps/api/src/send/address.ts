/**
 * The addr-spec out of a header value, and the domain out of that.
 *
 * ⚠ ONE IMPLEMENTATION, BECAUSE THIS HAS ALREADY BEEN WRONG ONCE. `From` may
 * carry a display name, and taking everything after the last `@` yields
 * `pslhq.app>` for `i10 test <noreply@pslhq.app>` — a trailing bracket that
 * produced a malformed `Message-ID` in delivered mail before it was caught. The
 * same slip on the direct route produces a DKIM `d=` that resolves nowhere, so
 * the message fails DMARC instead of merely looking odd.
 *
 * It lived in two places — `messageIdHeader` and the Stalwart transport's own
 * copy — with identical regexes and different fallbacks. Two copies of a parser
 * that has already been fixed once is two places to fix it the next time.
 *
 * ⚠ NOT AN RFC 5322 PARSER, AND DELIBERATELY NOT. It is one angle-bracket pair
 * or the whole string, which covers every form the contract's validation admits.
 * `addrSpec` in send/accept.ts makes the same trade for recipients and is
 * deliberately NOT this function: it is unanchored because it matches a
 * suppression list, where the leading address is the one that matters.
 */

/**
 * The bare `local@domain`, with any display name stripped.
 *
 * ⚠ AN SMTP ENVELOPE TAKES THIS FORM AND ONLY THIS FORM, which is not what the
 * previous client required and is why this exists. `Bob <bob@x.test>` in a
 * `RCPT TO` is not an address — it parses as a local part of `Bob <bob`, which
 * contains a space and an angle bracket and is invalid — so handing the header
 * form straight to the submission client would have failed EVERY send whose
 * recipient carried a display name, permanently, on the direct route only.
 * nodemailer unwrapped it for us; upyo validates instead, which is the better
 * trade but only if the unwrapping happens here.
 *
 * ⚠ IT IS THE HEADER THAT KEEPS THE DISPLAY NAME. `buildRawMessage` formats
 * `To:` from the same input through `formatAddress`, so the recipient still sees
 * the name — the envelope and the header carry different things on purpose,
 * exactly as they do for `Bcc`.
 */
export function addressOf(input: string): `${string}@${string}` | null {
  const angled = /<([^>]*)>\s*$/.exec(input)
  const address = (angled?.[1] ?? input).trim()

  // ⚠ THE CAST IS THE NARROWING `includes` CANNOT DO, AND IT LIVES HERE SO NO
  // CALLER HAS TO REPEAT IT. The template literal type is what upyo's envelope
  // demands; asserting it once, immediately after the check that earns it, is
  // the difference between one cast and one at every call site.
  return address.includes("@") ? (address as `${string}@${string}`) : null
}

/** The domain half of an address, lowercased. */
export function domainOf(from: string): string | null {
  const address = addressOf(from)
  if (!address) return null

  const domain = address
    .slice(address.lastIndexOf("@") + 1)
    .trim()
    .toLowerCase()
  return domain || null
}
