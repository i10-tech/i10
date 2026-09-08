import "server-only"

/**
 * Where to send someone once they are signed in.
 *
 * ⚠ THIS IS AN OPEN REDIRECT GUARD, AND IT IS THE REASON THIS FILE EXISTS.
 * The console appends `?redirect_url=…` when it bounces a signed-out visitor
 * here, so the parameter is attacker-controllable by construction: anyone can
 * send `auth.i10.tech/sign-in?redirect_url=https://i10.tech.evil.example`. A
 * sign-in page that forwards wherever it is told is a credential-phishing
 * primitive with our domain and our TLS certificate on it — the victim really
 * did sign in to i10, and then really was handed to somebody else.
 *
 * ⚠ THE CHECK IS ON ORIGIN EQUALITY, NEVER ON A PREFIX OR A SUFFIX.
 * `startsWith("https://dash.i10.tech")` admits
 * `https://dash.i10.tech.evil.example`, and `endsWith("i10.tech")` admits
 * `https://evili10.tech`. Parsing the URL and comparing `origin` exactly is the
 * only form of this that does not have a bypass.
 *
 * ⚠ AND IT RUNS ON THE SERVER. The allowlist is unprefixed runtime env — see
 * middleware.ts — so it is resolved in the page and handed to the client form
 * as a plain string. A client component could not read it, and a client-side
 * check would be advisory anyway.
 */

/** Where a sign-in with no destination of its own goes. */
const fallback = () => process.env.AUTH_DEFAULT_REDIRECT_URL ?? "/"

const allowed = () =>
  (process.env.AUTH_ALLOWED_REDIRECT_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)

export function afterAuthUrl(raw: string | string[] | undefined): string {
  const candidate = Array.isArray(raw) ? raw[0] : raw
  if (!candidate) return fallback()

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    // ⚠ A RELATIVE PATH IS REFUSED RATHER THAN ACCEPTED AS "SAME SITE". This
    // app serves no page worth landing on after sign-in, so a relative target
    // is either a mistake or an attempt at one — and `//evil.example` parses as
    // a protocol-relative URL that many naive checks read as a path.
    return fallback()
  }

  // ⚠ NOT `!== "http:"`. Only https is allowed, so anything exotic a URL parser
  // accepts — `javascript:`, `data:` — is refused by the same line.
  if (url.protocol !== "https:") return fallback()

  return allowed().includes(url.origin) ? url.toString() : fallback()
}
