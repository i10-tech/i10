"use client"

import * as React from "react"
import { AlertTriangle, Plus } from "lucide-react"
import { toast } from "sonner"
import { ActionButton } from "@repo/ui/components/action-button"
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
import { StepStage } from "@repo/ui/components/step-stage"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { ApiKeyScopeField, type ScopeDomain } from "@/components/api-key-scope"
import { createApiKey } from "@/lib/actions"
import { useOutcome } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"
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
export function CreateApiKeyButton({
  autoOpen = false,
  domains = [],
}: {
  autoOpen?: boolean
  /**
   * ⚠ PASSED IN RATHER THAN FETCHED HERE. The page is a server component that
   * is already talking to the API; a client fetch would put a second spinner
   * inside a dialog somebody has already opened, for a list that is usually
   * three rows long.
   */
  domains?: ScopeDomain[]
}) {
  const [open, setOpen] = React.useState(autoOpen)
  const [name, setName] = React.useState("")
  const [mode, setMode] = React.useState<"live" | "test">("live")
  /*
   * ⚠ `null` — EVERY DOMAIN — IS THE DEFAULT, AND CHANGING THAT WOULD BE A
   * BREAKING CHANGE DISGUISED AS A SAFER ONE. Defaulting to the first domain
   * would silently mint restricted keys for people who never read this field,
   * and they would find out when a send failed in production.
   */
  const [domain, setDomain] = React.useState<string | null>(null)
  const outcome = useOutcome()
  const pending = outcome.state === "pending"
  const [created, setCreated] = React.useState<CreatedApiKey | null>(null)

  // ⚠ CLEARED ON OPEN, NOT ON CLOSE — the name and the key used to vanish
  // in front of the person while the dialog was still fading out. See
  // `useResetOnOpen`.
  useResetOnOpen(open, () => {
    setName("")
    setMode("live")
    setDomain(null)
    setCreated(null)
    outcome.reset()
  })

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (outcome.state !== "idle" || !name.trim()) return

    let key: CreatedApiKey | null = null
    /*
     * ⚠ TICK, HOLD, THEN SLIDE ON TO THE SECRET — the same sequence as the
     * webhook dialog, so the two "copy this once" flows feel like one. The
     * table behind is already one row longer by the time the tick shows: the
     * action's own response re-rendered it (see `run` in lib/actions.ts), so
     * somebody glancing past the secret to check it worked sees the new row.
     */
    await outcome.run(
      async () => {
        const result = await createApiKey({ name: name.trim(), mode, domain })
        if (!result.ok) {
          toast.error("Could not create the key", { description: result.error })
          return false
        }
        key = result.data
        return true
      },
      () => setCreated(key),
    )
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
          if (pending) return
          setOpen(next)
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
          <StepStage step={created ? "secret" : "form"}>
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
                  <Button onClick={() => setOpen(false)}>I have copied it</Button>
                </DialogFooter>
              </>
            ) : (
              <form onSubmit={submit} {...outcome.formProps}>
                <DialogHeader>
                  <DialogTitle>Create an API key</DialogTitle>
                  <DialogDescription>
                    Name it after where it will live, so you know what you are revoking
                    later.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                  <ValidatedInput
                    label="Name"
                    id="key-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="off"
                    maxLength={50}
                    required="Name this key so you can recognise it later."
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
                            Prefixed <code className="font-mono">i10_test_</code> so it
                            is greppable in a leak scan and obvious in your own logs.
                          </span>
                        </span>
                      </label>
                    </RadioGroup>
                  </div>

                  <ApiKeyScopeField
                    id="key-domain"
                    value={domain}
                    onChange={setDomain}
                    domains={domains}
                    disabled={pending}
                  />
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
                  <ActionButton
                    type="submit"
                    state={outcome.state}
                    pendingLabel="Create key"
                    doneLabel="Created"
                    disabled={!name.trim()}
                  >
                    Create key
                  </ActionButton>
                </DialogFooter>
              </form>
            )}
          </StepStage>
        </DialogContent>
      </Dialog>
    </>
  )
}
