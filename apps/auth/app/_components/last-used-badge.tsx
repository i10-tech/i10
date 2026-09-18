/**
 * "Last used" — the hint that stops somebody creating a second account.
 *
 * ⚠ IT EXISTS TO STOP A DUPLICATE ACCOUNT, not to decorate a button. Somebody
 * who signed up with Google six months ago comes back, does not remember, types
 * their email and a password, and is told the password is wrong — or signs up
 * again and now has two accounts on one address with their data in the other
 * one. See _lib/last-used.ts for how the fact is recorded.
 *
 * ⚠ IT IS PINNED TO THE TOP EDGE NOW, AND `ms-auto` WAS A REAL BUG RATHER THAN
 * A STYLE CHOICE. As a flex CHILD of the button it took part in the layout: the
 * badge claimed the right-hand end of the row and `justify-center` then centred
 * what was left, so the label of any button carrying a badge sat visibly left of
 * the label of every button without one. Three buttons in a stack, one of them
 * with its text shifted — the badge was moving the thing it was annotating.
 *
 * ⚠ SO IT IS OUT OF FLOW ENTIRELY, AND THE PARENT MUST BE `relative`. Absolute
 * positioning costs the row nothing, which is the whole point: the label stays
 * exactly where it is whether or not this is rendered. Every call site adds
 * `relative` to the control it sits on.
 *
 * ⚠ AND IT NEEDS AN OPAQUE BACKGROUND, BECAUSE IT NOW SITS ON THE BORDER. A
 * translucent chip straddling a line shows the line through it. `bg-background`
 * is correct on the auth pages, which are the only place this renders — they are
 * always on the page's own surface, never in a card or a popover. (The field
 * notch in @repo/ui solves the same problem with a `<legend>` precisely because
 * IT has to work on three different surfaces; this one does not.)
 *
 * ⚠ NOT `aria-hidden`. A screen reader user has exactly the same problem this
 * solves — which of three identical-sounding buttons did I use — and hiding it
 * would leave them the only people without the answer. Inside a `<button>` it
 * joins the accessible name; beside a field it is read as the note it is.
 */

/**
 * ⚠ TWO COMPLETE CLASS STRINGS, NOT ONE BUILT FROM A VARIABLE. Tailwind finds
 * classes by scanning source text for whole literals, so `` `end-${x}` `` is
 * invisible to the compiler and the rule is never emitted — the same trap the
 * floating field's own note documents at length.
 */
const PLACEMENT = {
  /**
   * On a pill button. `end-5` clears the corner arc: a stadium's top edge is
   * only horizontal from x = radius inward, and a chip parked before that is a
   * chip sitting on a curve.
   */
  button: "-top-2 end-5",
  /**
   * On a floating field. Further in again, because that control's own label
   * notch opens at 28px and two chips on one border need to not collide — see
   * the geometry note in @repo/ui/components/floating-field.
   */
  field: "-top-2 end-6",
} as const

export function LastUsedBadge({
  placement = "button",
}: {
  placement?: keyof typeof PLACEMENT
}) {
  return (
    <span
      // ⚠ `pointer-events-none` SO IT CANNOT EAT A CLICK. It is painted over
      // the top edge of a button whose entire job is to be pressed, and a
      // 60×16 dead zone on that edge is the kind of defect nobody reports
      // because it only bites near the corner.
      className={`pointer-events-none absolute z-10 rounded-pill border bg-background px-1.5 py-0.5 text-2xs leading-none font-normal text-muted-foreground ${PLACEMENT[placement]}`}
    >
      Last used
    </span>
  )
}
