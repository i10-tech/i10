"use client"

/**
 * A console page's title: real text, still, from the first frame.
 *
 * ⚠ NO REVEAL (2026-11-09). One arrival mounts the title up to three times:
 * the skeleton drawn at the click, the route's loading.tsx about 100ms later,
 * then the page. Each played the letter reveal, so the header rose in, jumped
 * from half drawn to whole at the first swap, and rose in again at the next.
 * Static copy is real text the moment the page lands (docs/decisions/
 * skeletons.md, section 3); the motion belongs to the data.
 */
function Title({
  text,
  className,
  id,
}: {
  text: string
  className?: string
  id?: string
}) {
  return (
    <h1 data-slot="page-title" id={id} className={className}>
      {text}
    </h1>
  )
}

/** The title as a view draws it in both modes. */
export function PlaceholderTitle(props: { text: string; className?: string }) {
  return <Title {...props} />
}

/** The title `PageTitle` draws for plain text. */
export function RevealedTitle(props: {
  text: string
  className?: string
  id?: string
}) {
  return <Title {...props} />
}
