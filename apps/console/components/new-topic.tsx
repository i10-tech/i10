"use client"

import * as React from "react"
import { Info, Plus } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { RadioGroup, RadioGroupItem } from "@repo/ui/components/radio-group"
import { FloatingTextarea } from "@repo/ui/components/floating-field"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { FormDialog } from "@/components/form-dialog"
import { createTopic } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

/**
 * ⚠ THE DEFAULT SUBSCRIPTION CANNOT BE CHANGED LATER, AND THE FORM SAYS SO
 * WHILE THE DECISION IS BEING MADE — not afterwards, in a disabled control on
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

  // ⚠ CLEARED WHEN IT OPENS, NOT WHEN IT CLOSES — emptying the fields on
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
      successMessage="Topic created"
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
        <RadioGroup
          value={defaultSubscription}
          onValueChange={(value) =>
            setDefaultSubscription(value as "opt_in" | "opt_out")
          }
          className="gap-2"
        >
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 hover:bg-muted/30">
            <RadioGroupItem value="opt_in" className="mt-0.5" />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">Subscribed by default</span>
              <span className="block text-xs text-muted-foreground">
                Everyone receives it unless they opt out. Right for things people
                expect, like product updates.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border p-3 hover:bg-muted/30">
            <RadioGroupItem value="opt_out" className="mt-0.5" />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">Opt in required</span>
              <span className="block text-xs text-muted-foreground">
                Nobody receives it until they say yes. Right for anything you would
                hesitate to send unasked.
              </span>
            </span>
          </label>
        </RadioGroup>

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
        <RadioGroup
          value={visibility}
          onValueChange={(value) => setVisibility(value as "public" | "private")}
          className="gap-2"
        >
          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border p-2.5 hover:bg-muted/30">
            <RadioGroupItem value="public" />
            <span className="text-sm">
              Public
              <span className="ml-1.5 text-xs text-muted-foreground">
                listed on every preference page
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border p-2.5 hover:bg-muted/30">
            <RadioGroupItem value="private" />
            <span className="text-sm">
              Private
              <span className="ml-1.5 text-xs text-muted-foreground">
                only shown to people already subscribed
              </span>
            </span>
          </label>
        </RadioGroup>
      </fieldset>
    </FormDialog>
  )
}
