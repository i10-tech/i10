"use client"

import * as React from "react"
import { Reveal } from "@repo/ui/components/i10/reveal"

/** A refusal said where the person is looking, sliding in rather than snapping. */
export function InlineError({ message }: { message: string | null }) {
  const [shown, setShown] = React.useState(message)
  if (message && message !== shown) setShown(message)
  return (
    <Reveal show={Boolean(message)} spacing="pt-1">
      <p role="alert" className="text-sm text-destructive">
        {shown}
      </p>
    </Reveal>
  )
}
