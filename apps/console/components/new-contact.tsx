"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { Input } from "@repo/ui/components/input"
import { Label } from "@repo/ui/components/label"
import { FormDialog } from "@/components/form-dialog"
import { createContact } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

/**
 * ⚠ ADDING SOMEBODY WHO ALREADY EXISTS IS AN UPSERT, NOT A CONFLICT. It is what
 * a person does when they are not sure whether the address is already there,
 * and a 409 for that is an error message for a non-error. What it does NOT do
 * is re-subscribe them — `unsubscribed` is deliberately absent from the upsert's
 * update set, because somebody's choice to opt out has to outlive our imports.
 */
export function NewContactButton() {
  const [email, setEmail] = React.useState("")
  const [firstName, setFirstName] = React.useState("")
  const [lastName, setLastName] = React.useState("")
  const [open, setOpen] = React.useState(false)

  // ⚠ CLEARED WHEN IT OPENS, NOT WHEN IT CLOSES — emptying the fields on
  // close does it while the dialog is still animating out, which reads as
  // the input being wiped from under you. Adjusted during render rather
  // than in an effect; see lib/react.ts.
  useResetOnOpen(open, () => {
    setEmail("")
    setFirstName("")
    setLastName("")
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm">
          <Plus />
          Add contact
        </Button>
      }
      title="Add a contact"
      description="One row per person. If this address already exists, we update the name and leave their subscription choice alone."
      submitLabel="Add contact"
      canSubmit={email.includes("@")}
      successMessage="Contact added"
      onSubmit={() =>
        createContact({
          email: email.trim(),
          first_name: firstName.trim() || null,
          last_name: lastName.trim() || null,
        })
      }
    >
      <div className="space-y-2">
        <Label htmlFor="contact-email">Email address</Label>
        <Input
          id="contact-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="person@example.com"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="font-mono text-xs"
          required
          autoFocus
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="contact-first">First name</Label>
          <Input
            id="contact-first"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="contact-last">Last name</Label>
          <Input
            id="contact-last"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
            autoComplete="off"
          />
        </div>
      </div>
    </FormDialog>
  )
}
