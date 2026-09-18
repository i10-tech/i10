"use client"

import * as React from "react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { cn } from "cn"
import { renameWorkspace, updateOnboarding } from "@/lib/actions"

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
  const [pending, setPending] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending) return

    setPending(true)

    // ⚠ TWO INDEPENDENT WRITES, AND A FAILURE OF EITHER MUST NOT LOSE THE
    // OTHER. Renaming is the one that matters; the use case is research.
    if (value.trim() && value.trim() !== name) {
      const renamed = await renameWorkspace(value.trim())
      if (!renamed.ok) {
        setPending(false)
        toast.error("Could not save the name", { description: renamed.error })
        return
      }
    }

    if (selected && selected !== useCase) {
      await updateOnboarding({ use_case: selected })
    }

    setPending(false)
    onDone()
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Let&rsquo;s set up your workspace
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Four short steps and you will be sending. Nothing here is permanent — you can
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
          Optional. It helps us work out what to build next — nothing you pick changes
          what you can do.
        </p>
      </fieldset>

      <Button type="submit" disabled={pending}>
        {pending && <Spinner />}
        Continue
      </Button>
    </form>
  )
}
