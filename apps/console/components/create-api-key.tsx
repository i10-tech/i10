"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import { CopyField } from "@repo/ui/components/copy"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog"
import { Label } from "@repo/ui/components/label"
import { RadioGroup, RadioGroupItem } from "@repo/ui/components/radio-group"
import { Spinner } from "@repo/ui/components/spinner"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { createApiKey } from "@/lib/actions"
import type { CreatedApiKey } from "@/lib/types"

/**
 * Minting a key, and the one chance to copy it.
 *
 * ⚠ THE DIALOG DOES NOT CLOSE ON AN OUTSIDE CLICK ONCE THE SECRET IS ON SCREEN,
 * AND THAT IS THE MOST IMPORTANT BEHAVIOUR IN THIS FILE. Nothing stores the
 * secret — the API keeps a SHA-256 of it — so dismissing this by accident means
 * the key exists, is billed against the account, and can never be used. The
 * only way out is the button that says, in words, that it will not be shown
 * again.
 *
 * ⚠ AND THE SECRET IS NEVER PUT IN THE URL, IN `localStorage`, OR IN A TOAST.
 * A toast is dismissible, survives navigation in some implementations, and is
 * exactly the kind of thing that ends up in a screen recording.
 */
export function CreateApiKeyButton({ autoOpen = false }: { autoOpen?: boolean }) {
  const router = useRouter()
  const [open, setOpen] = React.useState(autoOpen)
  const [name, setName] = React.useState("")
  const [mode, setMode] = React.useState<"live" | "test">("live")
  const [pending, setPending] = React.useState(false)
  const [created, setCreated] = React.useState<CreatedApiKey | null>(null)

  function reset() {
    setName("")
    setMode("live")
    setCreated(null)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (pending || !name.trim()) return

    setPending(true)
    const result = await createApiKey({ name: name.trim(), mode })
    setPending(false)

    if (!result.ok) {
      toast.error("Could not create the key", { description: result.error })
      return
    }

    setCreated(result.data)
    // ⚠ REFRESHED NOW, WHILE THE SECRET IS STILL ON SCREEN. Refreshing on close
    // would leave the list one row short for as long as somebody spends copying
    // the key — which is exactly when they glance at the table to check it
    // worked.
    router.refresh()
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus />
        Create key
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          // ⚠ WHILE THE SECRET IS SHOWING, ONLY THE EXPLICIT BUTTON CLOSES IT.
          if (created && next === false) return
          setOpen(next)
          if (!next) reset()
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          // Escape and outside-click are the two paths the guard above cannot
          // see, because Radix handles them before `onOpenChange`.
          onEscapeKeyDown={(event) => created && event.preventDefault()}
          onPointerDownOutside={(event) => created && event.preventDefault()}
          showCloseButton={!created}
        >
          {created ? (
            <>
              <DialogHeader>
                <DialogTitle>Copy your key now</DialogTitle>
                <DialogDescription>
                  This is the only time it will ever be shown. We store a hash of it,
                  not the key itself — there is nothing to reveal later.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3">
                <CopyField value={created.secret} className="py-2" />

                <p className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <span>
                    Treat it like a password. If it leaks, rotate it — a rotated key
                    stops working immediately, not at the end of a cache window.
                  </span>
                </p>
              </div>

              <DialogFooter>
                <Button
                  onClick={() => {
                    setOpen(false)
                    reset()
                  }}
                >
                  I have copied it
                </Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={submit}>
              <DialogHeader>
                <DialogTitle>Create an API key</DialogTitle>
                <DialogDescription>
                  Name it after where it will live, so you know what you are revoking
                  later.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <FloatingInput
                  label="Name"
                  id="key-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="off"
                  maxLength={50}
                  required
                  autoFocus
                  hint="e.g. production-api"
                />

                <div className="space-y-2">
                  <Label>Mode</Label>
                  <RadioGroup
                    value={mode}
                    onValueChange={(value) => setMode(value as "live" | "test")}
                    className="gap-2"
                  >
                    <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-muted/30">
                      <RadioGroupItem value="live" className="mt-0.5" />
                      <span className="space-y-0.5">
                        <span className="block text-sm font-medium">Live</span>
                        <span className="block text-xs text-muted-foreground">
                          Sends real mail and counts against your allowance. Prefixed{" "}
                          <code className="font-mono">i10_live_</code>.
                        </span>
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-muted/30">
                      <RadioGroupItem value="test" className="mt-0.5" />
                      <span className="space-y-0.5">
                        <span className="block text-sm font-medium">Test</span>
                        <span className="block text-xs text-muted-foreground">
                          Prefixed <code className="font-mono">i10_test_</code> so it is
                          greppable in a leak scan and obvious in your own logs.
                        </span>
                      </span>
                    </label>
                  </RadioGroup>
                </div>
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
                <Button type="submit" disabled={pending || !name.trim()}>
                  {pending && <Spinner />}
                  Create key
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
