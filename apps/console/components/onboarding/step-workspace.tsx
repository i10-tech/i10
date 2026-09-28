"use client"

import * as React from "react"
import { toast } from "sonner"
import { ActionButton } from "@repo/ui/components/action-button"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { cn } from "cn"
import { renameWorkspace, updateOnboarding } from "@/lib/actions"
import { useOutcome } from "@/lib/outcome"

/**
 * ⚠ THE USE CASE IS PRODUCT RESEARCH AND NEVER LOGIC. Nothing branches on it,
 * no feature is gated by it, and it is stored as free text. The moment an
 * answer here changes what somebody is shown, this becomes a form people learn
 * to lie to.
 */
const USE_CASES = [
  "Transactional email",
  "Product updates",
  "Newsletters",
  "Notifications",
  "Something else",
]

export function StepWorkspace({
  name,
  useCase,
  onDone,
}: {
  name: string
  useCase: string | null
  onDone: () => void
}) {
  const [value, setValue] = React.useState(name)
  const [selected, setSelected] = React.useState(useCase ?? "")
  const outcome = useOutcome()

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (outcome.state !== "idle") return

    const renaming = value.trim() !== "" && value.trim() !== name
    const choosing = selected !== "" && selected !== useCase

    /*
     * ⚠ NOTHING CHANGED, NOTHING TO CONFIRM. Somebody returning to this step
     * and pressing Continue past values that are already stored should move on
     * at once; a "Saved" tick for a save that did not happen would be the
     * console congratulating itself.
     */
    if (!renaming && !choosing) {
      onDone()
      return
    }

    // ⚠ OTHERWISE THE SAME BEAT AS EVERY FORM: tick and green field, then the
    // step slides on. See lib/outcome.ts.
    await outcome.run(async () => {
      // ⚠ TWO INDEPENDENT WRITES, AND A FAILURE OF EITHER MUST NOT LOSE THE
      // OTHER. Renaming is the one that matters; the use case is research.
      if (renaming) {
        const renamed = await renameWorkspace(value.trim())
        if (!renamed.ok) {
          toast.error("Could not save the name", { description: renamed.error })
          return false
        }
      }

      if (choosing) {
        await updateOnboarding({ use_case: selected })
      }

      return true
    }, onDone)
  }

  return (
    <form onSubmit={submit} className="space-y-6" {...outcome.formProps}>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Let&rsquo;s set up your workspace
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Four short steps and you will be sending. Nothing here is permanent - you can
          change all of it later.
        </p>
      </div>

      <FloatingInput
        label="Workspace name"
        id="workspace-name"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        maxLength={120}
        autoFocus
        hint="What appears on your invoices."
      />

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">What will you be sending?</legend>
        <div className="flex flex-wrap gap-2">
          {USE_CASES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={selected === option}
              onClick={() => setSelected(selected === option ? "" : option)}
              className={cn(
                "cursor-pointer rounded-full border px-3 py-1.5 text-xs transition-colors",
                "duration-(--duration-instant) ease-(--ease-linear)",
                selected === option
                  ? "border-foreground/40 bg-muted"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Optional. It helps us work out what to build next - nothing you pick changes
          what you can do.
        </p>
      </fieldset>

      <ActionButton
        type="submit"
        state={outcome.state}
        pendingLabel="Continue"
        doneLabel="Saved"
      >
        Continue
      </ActionButton>
    </form>
  )
}
