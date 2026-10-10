"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Copy, FlaskConical, KeyRound, Pause, Play, Trash2 } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@repo/ui/components/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { FormDialog } from "@/components/form-dialog"
import { RowMenu } from "@/components/list/row-menu"
import { RotateSecretDialog } from "@/components/webhook-rotate-dialog"
import { deleteWebhook, sendWebhookTest, updateWebhook } from "@/lib/actions"
import { toastDone, toastError } from "@/lib/toast"
import { endpointName } from "@/lib/webhooks"
import type { WebhookEndpoint, WebhookEventType } from "@/lib/types"

/**
 * The endpoint page's own actions: a test event, and a menu for the rest.
 *
 * ⚠ A TEST EVENT GOES THROUGH THE REAL PATH - signed, retried, logged - and
 * is marked as a test, so it proves the receiver end to end. A paused or
 * disabled endpoint refuses one, so the button says why instead of failing.
 */
export function EndpointActions({
  endpoint,
  catalog,
}: {
  endpoint: WebhookEndpoint
  catalog: WebhookEventType[]
}) {
  const router = useRouter()
  const [testing, setTesting] = React.useState(false)
  const [rotating, setRotating] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  const setEnabled = async (enabled: boolean) => {
    const result = await updateWebhook(endpoint.id, { enabled })
    if (!result.ok) {
      toastError(
        enabled ? "Could not turn the endpoint on" : "Could not pause the endpoint",
        {
          description: result.error,
        },
      )
      return
    }
    toastDone(enabled ? "Endpoint turned on" : "Endpoint paused")
  }

  const off = !endpoint.enabled

  return (
    <>
      {off ? (
        <Button size="sm" onClick={() => void setEnabled(true)}>
          <Play />
          <span className="hidden sm:inline">
            {endpoint.health === "disabled" ? "Turn back on" : "Resume"}
          </span>
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="outline" onClick={() => setTesting(true)}>
              <FlaskConical />
              <span className="hidden sm:inline">Send test event</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent className="sm:hidden">Send test event</TooltipContent>
        </Tooltip>
      )}

      <RowMenu label={endpointName(endpoint)}>
        <DropdownMenuItem
          onSelect={() =>
            void navigator.clipboard.writeText(endpoint.id).then(
              () => toastDone("Endpoint ID copied"),
              () => toastError("Could not copy the ID"),
            )
          }
        >
          <Copy />
          Copy ID
        </DropdownMenuItem>
        {endpoint.kind !== "polling" && (
          <DropdownMenuItem onSelect={() => setRotating(true)}>
            <KeyRound />
            Rotate signing secret
          </DropdownMenuItem>
        )}
        {endpoint.enabled && (
          <DropdownMenuItem onSelect={() => void setEnabled(false)}>
            <Pause />
            Pause endpoint
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
          <Trash2 />
          Delete endpoint
        </DropdownMenuItem>
      </RowMenu>

      <TestEventDialog
        endpoint={endpoint}
        catalog={catalog}
        open={testing}
        onOpenChange={setTesting}
      />

      <RotateSecretDialog
        endpoint={rotating ? endpoint : null}
        onOpenChange={(open) => !open && setRotating(false)}
      />

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this endpoint?"
        description="Events stop being delivered to it immediately. Past deliveries stay in the log."
        confirmLabel="Delete endpoint"
        doneLabel="Deleted"
        confirmWord={endpointName(endpoint)}
        onConfirm={async () => {
          const result = await deleteWebhook(endpoint.id)
          if (!result.ok) {
            toastError("Could not delete the endpoint", { description: result.error })
            return false
          }
          router.push("/webhooks")
          return true
        }}
      />
    </>
  )
}

/**
 * ⚠ THE CHOICES ARE THE ENDPOINT'S OWN EVENTS FIRST. A test of an event the
 * endpoint is not subscribed to is still sent - it is a test - but the
 * likely question is "does my handler for this one work".
 */
function TestEventDialog({
  endpoint,
  catalog,
  open,
  onOpenChange,
}: {
  endpoint: WebhookEndpoint
  catalog: WebhookEventType[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const types = React.useMemo(() => {
    const all = catalog.length > 0 ? catalog.map((t) => t.type) : endpoint.events
    return [
      ...endpoint.events.filter((e) => all.includes(e)),
      ...all.filter((t) => !endpoint.events.includes(t)),
    ]
  }, [catalog, endpoint.events])
  const router = useRouter()
  const [type, setType] = React.useState(types[0] ?? "")

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Send a test event"
      description="An example of the event, signed and delivered like a real one, and marked as a test."
      submitLabel="Send test event"
      doneLabel="Sent"
      canSubmit={type !== ""}
      onSubmit={() => sendWebhookTest(endpoint.id, type)}
      // ⚠ ON TO THE DELIVERY ITSELF, where its attempt lands within a second:
      // "did my handler get it" is answered there, not by a toast.
      onSuccess={(data) => router.push(`/webhooks/deliveries/${data.delivery_id}`)}
    >
      <Select value={type} onValueChange={setType}>
        <SelectTrigger className="w-full font-mono text-xs" aria-label="Event type">
          <SelectValue placeholder="Choose an event" />
        </SelectTrigger>
        <SelectContent>
          {types.map((t) => (
            <SelectItem key={t} value={t} className="font-mono text-xs">
              {t}
              {!endpoint.events.includes(t) && (
                <span className="ml-2 font-sans text-2xs text-muted-foreground">
                  not subscribed
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormDialog>
  )
}
