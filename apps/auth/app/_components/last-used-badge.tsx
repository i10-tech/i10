/**
 * "Last used" — the hint that stops somebody creating a second account.
 *
 * ⚠ IT IS PUSHED TO THE END OF THE ROW RATHER THAN PLACED AFTER THE LABEL. The
 * buttons in this stack are full width and their labels differ in length; a
 * badge that follows the text would sit at a different horizontal position on
 * every button, which reads as three badges rather than one piece of
 * information. `ms-auto` pins it to the right edge, where the eye finds it once.
 *
 * ⚠ AND IT IS MUTED, NOT ACCENTED. It is a hint about what probably works, not
 * a recommendation and not a warning — and this is a sign-in page, where the
 * only thing that should compete for attention is the form.
 */
export function LastUsedBadge() {
  return (
    <span
      className="ms-auto rounded-full border px-1.5 py-0.5 text-2xs font-normal text-muted-foreground"
      // ⚠ NOT `aria-hidden`. A screen reader user has exactly the same problem
      // this solves — which of three identical-sounding buttons did I use — and
      // hiding it would leave them the only people without the answer.
    >
      Last used
    </span>
  )
}
