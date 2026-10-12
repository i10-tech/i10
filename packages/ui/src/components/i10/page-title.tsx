"use client"

import * as React from "react"
import { TextReveal } from "../text-reveal/text-reveal"

/**
 * A page title's one entrance, played once per arrival.
 *
 * ⚠ A LOADING SKELETON THAT SHOWS THE REAL TITLE PLAYS THE REVEAL ITSELF, AND
 * THE PAGE THAT REPLACES IT THEN SHOWS THE TITLE STILL. Both used to reveal:
 * the words rose in with the skeleton, and rose in again when the page
 * arrived a moment later - the header "showing twice" on every navigation.
 * The skeleton records the title it revealed; the page's title, mounting
 * over the same words, skips its entrance. A page that arrives without a
 * skeleton in between (a cached navigation) still reveals as before.
 */
let revealedByPlaceholder: string | null = null

/** The title as a loading skeleton shows it: revealed, and remembered. */
export function PlaceholderTitle({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  React.useEffect(() => {
    revealedByPlaceholder = text
  }, [text])
  return <TextReveal as="h1" text={text} className={className} />
}

/** The page's own title: revealed, unless its skeleton already did. */
export function RevealedTitle({
  text,
  className,
  id,
}: {
  text: string
  className?: string
  id?: string
}) {
  const [still] = React.useState(() => revealedByPlaceholder === text)
  React.useEffect(() => {
    revealedByPlaceholder = null
  }, [])
  if (still)
    return (
      <h1 data-slot="page-title" id={id} className={className}>
        {text}
      </h1>
    )
  return <TextReveal as="h1" text={text} className={className} id={id} />
}
