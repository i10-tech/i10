import { markerPattern } from "./markers.js"
import type { Variable } from "./variables.js"

/**
 * A skeleton as a person reads it: every marker shown as `{{{ path }}}`.
 *
 * ⚠ FOR DIFFS AND DISPLAY, NEVER FOR SENDING. Each version has its own nonce,
 * so two versions of an unchanged template differ at every variable when
 * compared raw. Written back as placeholders they differ only where the
 * template did. A marker the version's variables do not name is left as it
 * is, which a verified skeleton never has.
 */
export function displaySkeleton(
  text: string | null,
  nonce: string,
  variables: readonly Variable[],
): string | null {
  if (text === null) return null
  return text.replace(markerPattern(nonce), (whole, _prefix: string, index: string) => {
    const variable = variables[Number(index)]
    return variable ? `{{{ ${variable.path} }}}` : whole
  })
}
