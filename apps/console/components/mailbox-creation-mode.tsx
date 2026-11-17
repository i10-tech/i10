"use client"

import * as React from "react"
import { RadioCards } from "@repo/ui/components/radio-cards/radio-cards"
import { setCreationMode } from "@/lib/mailbox-settings-actions"
import {
  CREATION_MODES,
  creationModeSentence,
  onJoinCaveat,
  type CreationMode,
} from "@/lib/mailbox-settings"
import { useStepUp } from "@/lib/step-up"
import { toastDone, toastFailure } from "@/lib/toast"

/**
 * Who creates mailboxes: three choices an owner or admin changes, and one
 * sentence everybody else reads.
 *
 * ⚠ A CHANGE IS SAVED THE MOMENT IT IS CHOSEN, AND TAKEN BACK IF IT FAILS. The
 * three choices are one setting, so a Save button would only be a second click
 * for a thing with no half-finished state. The step-up comes first (the API
 * refuses a stale session, and the dialog that answers it is in the browser); a
 * person who declines it leaves the choice where it was.
 *
 * ⚠ THE CONTROL IS NOT RENDERED FOR A MEMBER, NOT DISABLED. A greyed-out choice
 * invites a question with no answer on the page; the sentence says what is true
 * and who to ask. The API refuses the change either way.
 */
export function MailboxCreationMode({
  mode,
  canChange,
  hostedDomains,
}: {
  mode: CreationMode
  canChange: boolean
  /** Domains this workspace hosts mailboxes on, for the one caveat that depends on it. */
  hostedDomains: number
}) {
  const stepUp = useStepUp()
  const [current, setCurrent] = React.useState(mode)
  const [saving, setSaving] = React.useState(false)

  // ⚠ A NEW SERVER ANSWER (another tab changed it, a revalidation) REPLACES THE
  // CHOICE, except while a save is in flight and would be overwritten by its own
  // older value.
  const [seen, setSeen] = React.useState(mode)
  if (mode !== seen) {
    setSeen(mode)
    if (!saving) setCurrent(mode)
  }

  async function choose(next: string) {
    const picked = next as CreationMode
    if (picked === current || saving) return
    const previous = current
    if (!(await stepUp())) return
    setCurrent(picked)
    setSaving(true)
    const result = await setCreationMode(picked)
    setSaving(false)
    if (!result.ok) {
      setCurrent(previous)
      toastFailure(result, { title: "Could not change who creates mailboxes" })
      return
    }
    setCurrent(result.data.mode)
    toastDone("Saved")
  }

  const caveat = onJoinCaveat(current, hostedDomains)

  if (!canChange) {
    return (
      <p className="max-w-prose text-sm">
        {creationModeSentence(current)}{" "}
        <span className="text-muted-foreground">
          Only an owner or admin can change this.
        </span>
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <RadioCards
        aria-label="Who creates mailboxes"
        layout="list"
        value={current}
        disabled={saving}
        onValueChange={(value) => void choose(value)}
        options={CREATION_MODES.map((option) => ({
          value: option.value,
          label: option.label,
          description: option.description,
        }))}
      />
      {caveat && (
        <p role="status" className="max-w-prose text-sm text-muted-foreground">
          {caveat}
        </p>
      )}
    </div>
  )
}
