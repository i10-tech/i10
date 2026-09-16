/**
 * The domain out of a `From` header.
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
export function domainOf(from: string): string | null {
  const angled = /<([^>]*)>\s*$/.exec(from)
  const address = (angled?.[1] ?? from).trim()

  const at = address.lastIndexOf("@")
  if (at === -1) return null

  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase()
  return domain || null
}
