/**
 * Who we say we are when we call somebody else's DNS API.
 *
 * ⚠ IT IS NOT `Bun/1.4.2`, WHICH IS WHAT BUN SENDS WHEN `fetch` IS GIVEN NO
 * `User-Agent` — verified against `cloudflare.com/cdn-cgi/trace`, which echoed
 * `uag=Bun/1.4.2`. A bare runtime name carries nothing an operator can act on,
 * and every operator of a public API asks automated clients to identify
 * themselves.
 *
 * ⚠ AND IT NO LONGER CARRIES `(+https://i10.tech)`, WHICH WAS THE OPPOSITE OF
 * POLITE ON A HOST BEHIND BOT MANAGEMENT. The `name/version (+url)` form is not
 * a general convention for contact details — it is specifically how a CRAWLER
 * declares itself: `Googlebot/2.1 (+http://www.google.com/bot.html)`,
 * `bingbot/2.0 (+http://www.bing.com/bingbot.htm)`,
 * `AhrefsBot/7.0 (+http://ahrefs.com/robot/)`. Cloudflare parses user agents
 * and keeps a list of VERIFIED bots; a self-declared one that is not on it is
 * scored worse than an unremarkable client, and `dash.cloudflare.com` — where
 * the OAuth token exchange happens — is a dashboard host with that scoring
 * switched on. We were volunteering the one signal most likely to be held
 * against us.
 *
 * ⚠ WRANGLER, WHICH TALKS TO THAT EXACT ENDPOINT, SENDS `node`. Its
 * `fetchAuthToken` sets only `Content-Type` and lets undici fill in the
 * default, so Cloudflare's own client identifies itself to its own OAuth
 * endpoint with a plain, boring token. `i10/1.0` is the same shape: a name and
 * a version, nothing claiming to be a robot and nothing pretending to be a
 * browser.
 *
 * ⚠ IT IS NOT A FIX FOR AN IP-BASED BLOCK, and that is worth being honest
 * about twice: a datacentre address is judged on its ASN, its reputation and
 * its TLS fingerprint as well. Measured 2026-09-20 from a residential
 * connection, the token endpoint answers ordinary OAuth JSON for every one of
 * `curl`, `Bun/1.4.2`, this string, the old one, and no user agent at all — so
 * the user agent is not sufficient to cause a challenge on its own. It is one
 * reason to be refused, and the only one that is ours to remove.
 *
 * ⚠ AND IT WAS NOT THE REASON. The measurement above was taken from a
 * residential line, WHERE NOTHING IS CHALLENGED — so it could not have
 * reproduced the failure it was written for. Repeated the same day from
 * psl-vps, `dash.cloudflare.com/oauth2/token` challenges every client we can
 * build: curl and Bun, HTTP/1.1 and h2, over IPv4 and over IPv6. It is the
 * ADDRESS, nothing here reaches it, and the exchange is now routed through
 * services/dns-oauth-broker. Keep sending this string — every other provider's
 * endpoint is an ordinary API host and identifying ourselves is still right —
 * but do not reach for it again when Cloudflare refuses.
 */
export const DNS_USER_AGENT = "i10/1.0"
