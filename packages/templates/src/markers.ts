/**
 * The placeholder a template's variables become while it is rendered once.
 *
 * ⚠ A TEMPLATE IS RENDERED ONCE PER VERSION, NEVER PER SEND. Uploaded TSX runs
 * in a sandbox exactly once, with every variable replaced by a marker, and what
 * comes out is stored as the version's skeleton. A send is then string
 * substitution into that skeleton: no customer code runs on the send path, and
 * nothing on it calls the sandbox. See docs/decisions/templates.md.
 *
 * ⚠ THE NONCE IS RANDOM PER RENDER AND CHOSEN AFTER THE SOURCE IS FIXED, so a
 * template cannot contain a marker by accident, and one it forges at runtime
 * can only point at its own variables. It is lowercase on purpose:
 * `toUpperCase()` on a variable turns its marker into something that is no
 * longer a marker, which is how a transformed variable is caught.
 *
 * Shape: `⟦i10<nonce>_<index>⟧`, with a trailing `u` before the bracket when the
 * marker sits in a URL attribute (see `substitute.ts`).
 */

export const OPEN = "⟦"
export const CLOSE = "⟧"

/** Twelve lowercase letters. Callers bring their own randomness; see `nonceFrom`. */
export const NONCE_LENGTH = 12

export function marker(nonce: string, index: number, url = false): string {
  return `${OPEN}i10${nonce}_${index}${url ? "u" : ""}${CLOSE}`
}

/**
 * A nonce from random bytes.
 *
 * ⚠ THE BYTES COME FROM THE CALLER because this package runs in a Worker and in
 * the API, and neither `crypto` global is in its type surface. Both callers use
 * `crypto.getRandomValues`.
 */
export function nonceFrom(bytes: Uint8Array): string {
  if (bytes.length < NONCE_LENGTH) throw new Error("nonceFrom needs 12 bytes")
  let out = ""
  for (let i = 0; i < NONCE_LENGTH; i++)
    out += String.fromCharCode(97 + (bytes[i]! % 26))
  return out
}

/**
 * Every marker of one nonce, in both cases.
 *
 * Groups: 1 the prefix and nonce (uppercase when the text was uppercased), 2
 * the index, 3 `u` for a URL position.
 *
 * ⚠ THE UPPERCASE FORM IS LEGITIMATE ONLY IN PLAIN TEXT. The HTML-to-text step
 * uppercases headings, so a variable in an `<h1>` reaches the text version as
 * `⟦I10…⟧`, and filling it with the uppercased value is exactly what a real
 * render would have produced. In HTML only our renderer's output is trusted to
 * be untransformed, so an uppercase marker there is a template transforming a
 * variable, and verification refuses it.
 */
export function markerPattern(nonce: string): RegExp {
  return new RegExp(
    `${OPEN}(i10${nonce}|I10${nonce.toUpperCase()})_(\\d+)(u?)${CLOSE}`,
    "g",
  )
}
