/**
 * The title and one line of explanation at the top of a step.
 *
 * ⚠ IT IS A COMPONENT BECAUSE IT APPEARS ELEVEN TIMES AND HAS TO BE IDENTICAL
 * IN ALL OF THEM. Every step of the sign-up flow, both stages of sign-in, the
 * passkey page and the second-factor page open with the same shape — and the
 * whole argument for stepping a form is that the container stays put while its
 * contents change. A heading that is `text-2xl` on one step and `text-xl` on
 * the next makes the panel appear to resize for no reason, which is exactly the
 * "hard jump" the stepped layout exists to remove.
 *
 * ⚠ `text-balance` ON THE DESCRIPTION, NOT THE TITLE. The descriptions are full
 * sentences that wrap to two lines at this width, and balancing stops the
 * second line being one orphaned word. Titles here are three or four words and
 * do not wrap, so balancing them costs a layout pass for nothing.
 */
export function StepHeading({
  title,
  children,
}: {
  title: string
  /** One sentence. Anything longer belongs in the step's own body. */
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <h1 className="font-display text-2xl font-bold">{title}</h1>
      {children ? (
        <p className="text-sm text-balance text-muted-foreground">{children}</p>
      ) : null}
    </div>
  )
}
