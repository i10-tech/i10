/**
 * How every overlay opens and closes: Base's enter/exit pattern, driven by the
 * motion tokens (`surface-enter` / `surface-exit` in tokens.css). Add the
 * string for the kind of surface to its Radix `...Content` className.
 *
 * ⚠ ONE FILE, SO SURFACES THAT SIT SIDE BY SIDE CANNOT DRIFT. A menu that
 * slides beside a popover that snaps reads as two products.
 *
 * ⚠ THE STRINGS ARE WRITTEN OUT IN FULL, NEVER ASSEMBLED. Tailwind finds
 * classes by scanning source text; a class built from a template literal is
 * never generated, and the overlay silently stops moving again.
 *
 * ⚠ EVERY STRING CARRIES `motion-surface`, which is what turns reduced motion
 * into a 100ms fade rather than a hard cut (see tokens.css).
 *
 * | surface                    | enter                      | exit                       | travel            |
 * | -------------------------- | -------------------------- | -------------------------- | ----------------- |
 * | popover, menu, select, card | 500ms quint-out            | 200ms quad-in (dismiss)    | 4px from trigger  |
 * | tooltip                    | 100ms linear               | 100ms linear               | none, fade only   |
 * | dialog                     | 200ms quint-out            | 200ms quad-in              | 8px up            |
 * | backdrop                   | 200ms linear               | 200ms linear               | none, fade only   |
 * | sheet                      | 500ms quint-out (entering) | 400ms quint-in (exiting)   | its own size      |
 */

/** Popovers, menus, selects, hover cards: 4px from the side they open on. */
export const surfaceMotion = [
  "motion-surface",
  "data-[state=open]:animate-[surface-enter_var(--duration-move)_var(--ease-quint-out)]",
  "data-[state=closed]:animate-[surface-exit_var(--duration-dismiss)_var(--ease-quad-in)_forwards]",
  "data-[side=right]:[--surface-x:-4px] data-[side=left]:[--surface-x:4px]",
  "data-[side=top]:[--surface-y:4px] data-[side=bottom]:[--surface-y:-4px]",
].join(" ")

/**
 * Tooltips: a fade and nothing else. It appears under the pointer on hover;
 * anything that travels there is motion in the corner of somebody's eye while
 * they read something else. Radix marks it `delayed-open` or `instant-open`.
 */
export const tooltipMotion = [
  "motion-surface",
  "data-[state=delayed-open]:animate-[surface-enter_var(--duration-instant)_var(--ease-linear)]",
  "data-[state=instant-open]:animate-[surface-enter_var(--duration-instant)_var(--ease-linear)]",
  "data-[state=closed]:animate-[surface-exit_var(--duration-instant)_var(--ease-linear)_forwards]",
].join(" ")

/** Dialogs: a short rise into the centre, and a dismissal out. */
export const dialogMotion = [
  "motion-surface [--surface-y:8px]",
  "data-[state=open]:animate-[surface-enter_var(--duration-dismiss)_var(--ease-quint-out)]",
  "data-[state=closed]:animate-[surface-exit_var(--duration-dismiss)_var(--ease-quad-in)_forwards]",
].join(" ")

/** The dimmed page behind a dialog or sheet: opacity only, so linear. */
export const backdropMotion = [
  "motion-surface",
  "data-[state=open]:animate-[surface-enter_var(--duration-dismiss)_var(--ease-linear)]",
  "data-[state=closed]:animate-[surface-exit_var(--duration-dismiss)_var(--ease-linear)_forwards]",
].join(" ")

/**
 * Sheets: in from their own edge, the whole way. Entering is 500ms quint-out;
 * leaving is a passive exit, 400ms quint-in. Pick the travel by side.
 */
export const sheetMotion = {
  base: [
    "motion-surface",
    "data-[state=open]:animate-[surface-enter_var(--duration-move)_var(--ease-quint-out)]",
    "data-[state=closed]:animate-[surface-exit_var(--duration-exit)_var(--ease-quint-in)_forwards]",
  ].join(" "),
  right: "[--surface-x:100%]",
  left: "[--surface-x:-100%]",
  top: "[--surface-y:-100%]",
  bottom: "[--surface-y:100%]",
} as const
