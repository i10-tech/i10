"use client"

import * as React from "react"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@repo/ui/components/field"
import { Switch } from "@repo/ui/components/switch"
import { updateDomainTracking } from "@/lib/actions"
import { toastError } from "@/lib/toast"

type Setting = "open_tracking" | "click_tracking"

/**
 * Open and click tracking for one domain (#154).
 *
 * ⚠ OPTIMISTIC, AND PUT BACK ON FAILURE. A switch that waits for the round
 * trip before moving reads as broken; one that moves and silently stays wrong
 * is worse. So it moves at once, and a refused save returns it to where it was
 * with the reason in a toast.
 *
 * ⚠ THE DESCRIPTIONS SAY WHAT ACTUALLY HAPPENS TO THE MAIL. "Track opens" alone
 * hides that a pixel is added and links are rewritten, which is exactly what
 * somebody deciding whether they have a lawful basis for it needs to know.
 */
export function DomainTracking({
  id,
  openTracking,
  clickTracking,
}: {
  id: string
  openTracking: boolean
  clickTracking: boolean
}) {
  const [values, setValues] = React.useState({
    open_tracking: openTracking,
    click_tracking: clickTracking,
  })
  const [saving, setSaving] = React.useState<Setting | null>(null)

  async function change(setting: Setting, next: boolean) {
    const previous = values[setting]
    setValues((v) => ({ ...v, [setting]: next }))
    setSaving(setting)
    const result = await updateDomainTracking(id, { [setting]: next })
    setSaving(null)
    if (!result.ok) {
      setValues((v) => ({ ...v, [setting]: previous }))
      toastError("Could not save the tracking setting", { description: result.error })
    }
  }

  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="open-tracking">Open tracking</FieldLabel>
          <FieldDescription>
            Adds an invisible image to each message and records when it loads. Some mail
            apps load images automatically, so opens are an estimate.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="open-tracking"
          checked={values.open_tracking}
          disabled={saving === "open_tracking"}
          onCheckedChange={(next) => change("open_tracking", next)}
        />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="click-tracking">Click tracking</FieldLabel>
          <FieldDescription>
            Sends every link through a redirect that records the click before forwarding
            to the original address.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="click-tracking"
          checked={values.click_tracking}
          disabled={saving === "click_tracking"}
          onCheckedChange={(next) => change("click_tracking", next)}
        />
      </Field>
    </FieldGroup>
  )
}
