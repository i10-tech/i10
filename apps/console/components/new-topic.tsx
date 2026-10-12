"use client"

import * as React from "react"
import { Info, Plus } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import { RadioCards } from "@repo/ui/components/radio-cards/radio-cards"
import { FloatingTextarea } from "@repo/ui/components/i10/floating-field"
import { ValidatedInput } from "@repo/ui/components/i10/validated-field"
import { FormDialog } from "@/components/form-dialog"
import { createTopic } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

/**
 * ⚠ THE DEFAULT SUBSCRIPTION CANNOT BE CHANGED LATER, AND THE FORM SAYS SO
 * WHILE THE DECISION IS BEING MADE - not afterwards, in a disabled control on
 * an edit screen. Flipping opt-out to opt-in would retroactively subscribe
 * everybody who never answered, which is sending marketing mail to people who
 * did not ask for it, at scale, because of a dropdown. The API refuses the
 * field outright for the same reason.
 */
export function NewTopicButton() {
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [defaultSubscription, setDefaultSubscription] = React.useState<
    "opt_in" | "opt_out"
  >("opt_in")
  const [visibility, setVisibility] = React.useState<"public" | "private">("public")
  const [open, setOpen] = React.useState(false)

  // ⚠ CLEARED WHEN IT OPENS, NOT WHEN IT CLOSES - emptying the fields on
  // close does it while the dialog is still animating out, which reads as
  // the input being wiped from under you. Adjusted during render rather
  // than in an effect; see lib/react.ts.
  useResetOnOpen(open, () => {
    setName("")
    setDescription("")
    setDefaultSubscription("opt_in")
    setVisibility("public")
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm">
          <Plus />
          New topic
        </Button>
      }
      title="Create a topic"
      description="A choice your recipients get on their preference page."
      canSubmit={name.trim().length > 0}
      onSubmit={() =>
        createTopic({
          name: name.trim(),
          description: description.trim(),
          default_subscription: defaultSubscription,
          visibility,
        })
      }
    >
      <ValidatedInput
        label="Name"
        id="topic-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
        required="Name this topic."
        autoFocus
        hint="Recipients see this. Write it the way you would say it to them."
      />

      <FloatingTextarea
        label="Description"
        id="topic-description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        rows={2}
        hint="e.g. What we ship, roughly once a month."
      />

      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium">Default</legend>
        <RadioCards
          aria-label="Default"
          layout="list"
          value={defaultSubscription}
          onValueChange={(value) =>
            setDefaultSubscription(value as "opt_in" | "opt_out")
          }
          options={[
            {
              value: "opt_in",
              label: "Subscribed by default",
              description:
                "Everyone receives it unless they opt out. Right for things people expect, like product updates.",
            },
            {
              value: "opt_out",
              label: "Opt in required",
              description:
                "Nobody receives it until they say yes. Right for anything you would hesitate to send unasked.",
            },
          ]}
        />

        <p className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            This cannot be changed later. Switching it would retroactively change what
            every existing contact has agreed to.
          </span>
        </p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium">Visibility</legend>
        <RadioCards
          aria-label="Visibility"
          layout="list"
          value={visibility}
          onValueChange={(value) => setVisibility(value as "public" | "private")}
          options={[
            {
              value: "public",
              label: "Public",
              description: "Listed on every preference page.",
            },
            {
              value: "private",
              label: "Private",
              description: "Only shown to people already subscribed.",
            },
          ]}
        />
      </fieldset>
    </FormDialog>
  )
}
