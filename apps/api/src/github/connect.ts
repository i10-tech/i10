import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Proving who is connecting what (#235).
 *
 * The install flow: the console sends the person to GitHub with a signed
 * `state` naming their workspace; GitHub sends them back to the console with
 * `installation_id`, `code` and that `state`. Three things are then checked:
 *
 *   1. `state` is ours, unexpired, and names the workspace of the person now
 *      signed in - so a link crafted for another workspace does nothing here;
 *   2. `code` exchanges for a user token - so it came from GitHub, now;
 *   3. that user's own installations include `installation_id`.
 *
 * ⚠ THE THIRD IS THE ONE THAT MATTERS. `installation_id` is a URL parameter;
 * without the check, anybody could edit it to another organization's
 * installation and have that organization's templates pushed into their
 * workspace. GitHub's own guidance is exactly this check.
 */

const STATE_TTL_MS = 30 * 60_000

function stateKey(clientSecret: string): Buffer {
  return createHmac("sha256", clientSecret).update("i10-github-install-state").digest()
}

export function signState(
  tenantId: string,
  clientSecret: string,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      t: tenantId,
      e: now + STATE_TTL_MS,
      n: randomBytes(8).toString("hex"),
    }),
  ).toString("base64url")
  const mac = createHmac("sha256", stateKey(clientSecret))
    .update(payload)
    .digest("base64url")
  return `${payload}.${mac}`
}

/** The workspace a state was signed for, if it is genuine and unexpired. */
export function verifyState(
  state: string,
  clientSecret: string,
  now = Date.now(),
): string | null {
  const [payload, mac] = state.split(".")
  if (!payload || !mac) return null
  const expected = createHmac("sha256", stateKey(clientSecret)).update(payload).digest()
  const given = Buffer.from(mac, "base64url")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const { t, e } = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      t?: unknown
      e?: unknown
    }
    return typeof t === "string" && typeof e === "number" && e > now ? t : null
  } catch {
    return null
  }
}

/**
 * `X-Hub-Signature-256` against the raw body.
 *
 * ⚠ THE RAW BYTES, NEVER A RE-SERIALIZED BODY, and in constant time. The
 * signature is the whole of the webhook's authorization.
 */
export function verifyWebhook(
  body: string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header?.startsWith("sha256=")) return false
  const given = Buffer.from(header.slice(7), "hex")
  const expected = createHmac("sha256", secret).update(body).digest()
  return given.length === expected.length && timingSafeEqual(given, expected)
}
