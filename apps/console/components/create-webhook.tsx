"use client"

import * as React from "react"
import { AlertTriangle, Plus } from "lucide-react"
import { ActionButton } from "@repo/ui/components/action-button"
import { Button } from "@repo/ui/components/button"
import { Checkbox } from "@repo/ui/components/checkbox"
import { CopyField } from "@repo/ui/components/copy"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog"
import { StepStage } from "@repo/ui/components/step-stage"
import { FloatingInput } from "@repo/ui/components/floating-field"
import { ValidatedInput } from "@repo/ui/components/validated-field"
import { httpsUrlProblem } from "@repo/ui/checks"
import { createWebhook } from "@/lib/actions"
import { WEBHOOK_EVENTS } from "@/components/webhook-events"
import { useOutcome } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"
import type { WebhookEndpoint } from "@/lib/types"
import { toastError } from "@/lib/toast"

/**
 * Adding an endpoint.
 *
 * ⚠ THE SIGNING SECRET IS SHOWN ONCE, LIKE AN API KEY, AND FOR THE SAME REASON:
 * the API stores it encrypted and never returns it again. Without it a customer
 * cannot verify that a POST came from us - which means either they trust
 * anything that hits the URL, or their handler stops working. The dialog says
 * so rather than assuming they know.
 *
 * ⚠ AND EVERY EVENT IS SELECTED BY DEFAULT. The common case is "tell me
 * everything"; making somebody tick six boxes to get the obvious outcome is
 * friction for its own sake, and an endpoint created with none selected
 * silently receives nothing - which looks exactly like a broken webhook.
 */
export function CreateWebhookButton({ autoOpen = false }: { autoOpen?: boolean }) {
  const [open, setOpen] = React.useState(autoOpen)
  const [url, setUrl] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [events, setEvents] = React.useState<string[]>(
    WEBHOOK_EVENTS.map((event) => event.value),
  )
  const outcome = useOutcome()
  const [created, setCreated] = React.useState<WebhookEndpoint | null>(null)

  /*
   * ⚠ CLEARED ON OPEN, NOT ON CLOSE. It used to run on close, so the URL and
   * the ticked events emptied in front of the person while the dialog was
   * still fading out - and the secret panel collapsed back to the form in the
   * same frame. See `useResetOnOpen`.
   */
  useResetOnOpen(open, () => {
    setUrl("")
    setDescription("")
    setEvents(WEBHOOK_EVENTS.map((event) => event.value))
    setCreated(null)
    outcome.reset()
  })

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (outcome.state !== "idle") return

    if (events.length === 0) {
      toastError("Choose at least one event", {
        description: "An endpoint subscribed to nothing never receives anything.",
      })
      return
    }

    let endpoint: WebhookEndpoint | null = null
    /*
     * ⚠ THE TICK FIRST, THEN THE SECRET. The form confirms in place - button,
     * green fields - and after the hold the dialog slides on to the one thing
     * that has to be copied. Jumping straight to the secret skipped the "that
     * worked" beat and hard-cut one panel for another of a different height.
     */
    await outcome.run(
      async () => {
        const result = await createWebhook({
          url: url.trim(),
          events,
          ...(description.trim() ? { description: description.trim() } : {}),
        })
        if (!result.ok) {
          toastError("Could not create the endpoint", { description: result.error })
          return false
        }
        endpoint = result.data
        return true
      },
      () => setCreated(endpoint),
    )
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus />
        Add endpoint
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (created && next === false) return
          if (outcome.state === "pending") return
          setOpen(next)
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          onEscapeKeyDown={(event) => created && event.preventDefault()}
          onPointerDownOutside={(event) => created && event.preventDefault()}
          showCloseButton={!created}
        >
          <StepStage step={created ? "secret" : "form"}>
            {created ? (
              <>
                <DialogHeader>
                  <DialogTitle>Copy your signing secret</DialogTitle>
                  <DialogDescription>
                    Use it to verify that a request came from us. It is stored encrypted
                    and cannot be shown again - rotate it if you lose it.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                  <CopyField value={created.secret ?? ""} className="py-2" />
                  <p className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                    <span>
                      An endpoint that does not verify the signature will accept a
                      forged POST from anyone who guesses the URL.
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
                  <DialogTitle>Add a webhook endpoint</DialogTitle>
                  <DialogDescription>
                    We POST a JSON body to this URL for every event you select.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                  <ValidatedInput
                    label="Endpoint URL"
                    id="webhook-url"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                    check={httpsUrlProblem}
                    required="Enter the URL to post to."
                    autoFocus
                    hint="Must be HTTPS and publicly reachable. Localhost will not work - use a tunnel while developing."
                  />

                  <FloatingInput
                    label="Description"
                    id="webhook-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    autoComplete="off"
                    hint="e.g. Production handler"
                  />

                  <fieldset className="space-y-2">
                    <legend className="mb-1 text-sm font-medium">Events</legend>
                    <div className="space-y-1.5 rounded-md border p-3">
                      {WEBHOOK_EVENTS.map((event) => (
                        <label
                          key={event.value}
                          className="flex cursor-pointer items-start gap-2.5"
                        >
                          <Checkbox
                            checked={events.includes(event.value)}
                            onCheckedChange={(checked) =>
                              setEvents((prev) =>
                                checked
                                  ? [...prev, event.value]
                                  : prev.filter((value) => value !== event.value),
                              )
                            }
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="block font-mono text-xs">
                              {event.value}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {event.description}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </div>

                <DialogFooter>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setOpen(false)}
                    disabled={outcome.state === "pending"}
                  >
                    Cancel
                  </Button>
                  <ActionButton
                    type="submit"
                    state={outcome.state}
                    pendingLabel="Add endpoint"
                    doneLabel="Added"
                    disabled={!url.trim()}
                  >
                    Add endpoint
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
