"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/ui/components/dialog"
import { Spinner } from "@repo/ui/components/spinner"
import type { ActionResult } from "@/lib/actions"
import { useResetOnOpen } from "@/lib/react"

/**
 * The shape every small create/edit dialog in the console shares.
 *
 * ⚠ IT EXISTS SO THAT ERROR HANDLING IS WRITTEN ONCE. Eight dialogs each doing
 * their own `try`, their own toast and their own refresh is eight chances for
 * one of them to close on a failure — which tells somebody the thing was
 * created when it was not, and the list they return to proves them wrong. Here
 * the rule is in one place: a failed submit keeps the dialog open and shows the
 * API's own message.
 *
 * ⚠ AND IT REFRESHES THE ROUTER RATHER THAN MUTATING CLIENT STATE. Every list
 * in this console is server-rendered; the actions already call
 * `revalidatePath`, so `router.refresh()` is what actually redraws the table.
 * Without it the write lands and the screen does not change.
 */
export function FormDialog<T>({
  trigger,
  title,
  description,
  submitLabel = "Create",
  onSubmit,
  onSuccess,
  successMessage,
  children,
  open: controlledOpen,
  onOpenChange: setControlledOpen,
  canSubmit = true,
}: {
  trigger?: React.ReactNode
  title: string
  description?: string
  submitLabel?: string
  onSubmit: () => Promise<ActionResult<T>>
  onSuccess?: (data: T) => void
  successMessage?: string | ((data: T) => string)
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  canSubmit?: boolean
}) {
  const router = useRouter()
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = setControlledOpen ?? setUncontrolledOpen

  // ⚠ CLEARED ON OPEN, NOT ON CLOSE — resetting on close empties the form while
  // the dialog is still animating out, which looks like the input being wiped.
  useResetOnOpen(open, () => setError(null))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending || !canSubmit) return

    setPending(true)
    setError(null)
    const result = await onSubmit()
    setPending(false)

    if (!result.ok) {
      // ⚠ INLINE, NOT A TOAST. The error almost always names a field — "a
      // property with that key already exists" — and a toast puts it where the
      // person is not looking while the form still shows what they typed.
      setError(result.error)
      return
    }

    if (successMessage) {
      toast.success(
        typeof successMessage === "function"
          ? successMessage(result.data)
          : successMessage,
      )
    }

    onSuccess?.(result.data)
    setOpen(false)
    router.refresh()
  }

  return (
    <Dialog open={open} onOpenChange={pending ? () => {} : setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>

          <div className="space-y-4 py-4">
            {children}
            {error && (
              <p className="rounded-md border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !canSubmit}>
              {pending && <Spinner />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
