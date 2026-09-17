import * as React from "react"
import { Status as StatusChrome } from "@repo/ui/components/status"
import { describeStatus } from "@/lib/status"

export { StatusDot } from "@repo/ui/components/status"
export type { Tone } from "@repo/ui/components/status"
export { describeStatus }

/**
 * A wire state, drawn.
 *
 * ⚠ THE VOCABULARY IS RESOLVED HERE AND THE DRAWING IS DONE IN `packages/ui`,
 * AND THAT SEAM IS THE POINT. `bounced` and `temporary_failure` are i10's
 * words — half of them on the API's public contract — so the table that maps
 * them to a tone belongs with the product, in `lib/status.ts`. What the design
 * system owns is five tones, a dot, a pill and the accessibility rule. A call
 * site still writes `<Status status={email.last_event} />`, so the layering
 * costs the caller nothing.
 */
export function Status({
  status,
  label,
  ...props
}: Omit<React.ComponentProps<typeof StatusChrome>, "tone" | "label"> & {
  /** The wire value. See `describeStatus`. */
  status: string
  /**
   * Overrides the mapped label. For counts — "3 failed" — not for renaming.
   *
   * ⚠ IT TAKES A NODE SO A CALLER CAN VISUALLY HIDE THE WORD WITHOUT REMOVING
   * IT. A narrow column sometimes has no room for the text, and the obvious
   * answer — pass an empty string — deletes the only non-colour signal this
   * component has. `<span className="sr-only">…</span>` keeps it for a screen
   * reader and for anybody who cannot tell the dots apart.
   */
  label?: React.ReactNode
}) {
  const described = describeStatus(status)

  return (
    // ⚠ `data-status` CARRIES THE RAW WIRE VALUE, NOT THE PRETTY LABEL. It is
    // what a test selects on and what somebody reads in the inspector when a
    // row looks wrong, and the label is lossy — several states share one word
    // in other vocabularies and would stop being distinguishable.
    <StatusChrome
      data-status={status}
      tone={described.tone}
      label={label ?? described.label}
      {...props}
    />
  )
}
