import { Mark } from "@repo/ui/components/mark"

/**
 * The mark in the corner: the slanted i10 ligature from i10.tech.
 *
 * ⚠ THE SAME GLYPH AS THE LANDING PAGE, FROM ONE SET OF PATHS in
 * @repo/ui/components/mark. It is `currentColor`, so it follows the theme the
 * way the type placeholder it replaced did: white on the black rail, black on
 * the light one.
 */
export function Wordmark() {
  return <Mark className="h-5 w-auto" />
}
