/**
 * The mark in the corner.
 *
 * ⚠ TYPE, NOT A LOGO FILE, BECAUSE THERE IS NO LOGO YET AND INVENTING ONE IS
 * NOT THIS BUILD'S DECISION. The same rule the token sheet applies to `--brand`:
 * a mark drawn here becomes the default that is hard to argue with later. A
 * wordmark set in the product's own typeface is honest about being a
 * placeholder while still looking deliberate.
 *
 * ⚠ AND IT IS NOT AN <svg> WITH A HARD-CODED FILL. On a true-black canvas a
 * black mark disappears and a white one burns in light mode; `currentColor` via
 * the text colour follows the theme for free.
 */
export function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="grid size-6 place-items-center rounded-md bg-foreground font-mono text-xs font-semibold text-background"
      >
        i
      </span>
      <span className="text-sm font-semibold tracking-tight">i10</span>
    </span>
  )
}
