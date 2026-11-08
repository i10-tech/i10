import "server-only"

/**
 * The SAML routes' browser half (#339): reading what an IdP POSTs, bounded.
 * apps/auth only forwards; the API parses every field with zod and verifies
 * everything (identity/saml.ts).
 */

/** A SAML response with an encrypted assertion and certificates fits well under this. */
export const MAX_SAML_FORM = 400 * 1024

const CONNECTION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function connectionOf(value: string): string | null {
  return CONNECTION.test(value) ? value.toLowerCase() : null
}

/**
 * An `application/x-www-form-urlencoded` body, or null when it is not one,
 * or too big.
 *
 * ⚠ READ WITH A CAP, NOT `formData()`: the IdP's POST is public, and an
 * unbounded body is a memory bill anybody can send us.
 */
export async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? ""
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_SAML_FORM || !request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_SAML_FORM) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks))
  return new URLSearchParams(text)
}
