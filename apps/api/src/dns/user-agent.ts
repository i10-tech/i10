/**
 * Who we say we are when we call somebody else's DNS API.
 *
 * ⚠ THE DEFAULT IS `Bun/1.4.2`, AND THAT IS A BOT SIGNATURE. Bun sends its own
 * name and version when `fetch` is given no `User-Agent` — verified against
 * `cloudflare.com/cdn-cgi/trace`, which echoed `uag=Bun/1.4.2`. A generic
 * runtime string arriving from a hosting-provider IP range is the exact shape
 * bot management is built to stop, and Cloudflare's token endpoint at
 * `dash.cloudflare.com` is behind it: the same endpoint answers `python-urllib`
 * with error 1010 (`browser_signature_banned`) while answering curl normally.
 *
 * ⚠ AND IT IS A CONTACTABLE NAME, NOT A DISGUISE. Every operator of a public
 * API asks automated clients to identify themselves and give a way to be
 * reached, and pretending to be a browser is both a lie and the thing bot
 * management is actually looking for. If we are ever rate-limited or blocked,
 * this string is what makes the conversation possible.
 *
 * ⚠ IT IS NOT A FIX FOR AN IP-BASED BLOCK, and it is worth being honest about
 * that: a datacentre address is judged on more than its user agent. It removes
 * one reason to be refused, which is the only one that is ours to remove.
 */
export const DNS_USER_AGENT = "i10/1.0 (+https://i10.tech)"
