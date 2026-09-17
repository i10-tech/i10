"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { KeyRound, MoreHorizontal, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@repo/ui/components/badge"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { Status } from "@/components/status"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { deleteWebhook, rotateWebhookSecret } from "@/lib/actions"
import type { WebhookEndpoint } from "@/lib/types"
import { Time } from "@/components/time"

/**
 * The endpoints, as cards rather than a table.
 *
 * ⚠ A CARD PER ENDPOINT, BECAUSE THE EVENT LIST IS THE INTERESTING PART AND IT
 * DOES NOT FIT IN A CELL. Six event names is 80-odd characters; in a table
 * column that is either truncated — hiding the exact thing somebody is checking
 * — or it forces the URL column down to nothing. Most accounts have one to three
 * endpoints, so a list of cards costs no scrolling.
 *
 * ⚠ AND A DISABLED ENDPOINT SAYS SO LOUDLY. The API disables an endpoint after
 * repeated failures; from the customer's side their handler simply stopped
 * being called, with nothing to explain it. This badge is the explanation.
 */
export function WebhookList({ endpoints }: { endpoints: WebhookEndpoint[] }) {
  const router = useRouter()
  const [deleting, setDeleting] = React.useState<WebhookEndpoint | null>(null)
  const [rotated, setRotated] = React.useState<WebhookEndpoint | null>(null)

  if (endpoints.length === 0) {
    return (
      <EmptyState
        title="No endpoints yet"
        description="Add one to receive delivery, bounce and complaint events as they happen — rather than polling for them."
      />
    )
  }

  return (
    <>
      <ul className="space-y-3">
        {endpoints.map((endpoint) => (
          <li key={endpoint.id} className="rounded-lg border">
            <div className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-sm">{endpoint.url}</span>
                  <Status status={endpoint.enabled ? "enabled" : "disabled"} />
                </div>
                {endpoint.description && (
                  <p className="text-xs text-muted-foreground">
                    {endpoint.description}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Added <Time iso={endpoint.created_at} />
                </p>
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${endpoint.url}`}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={async () => {
                      const result = await rotateWebhookSecret(endpoint.id)
                      if (!result.ok) {
                        toast.error("Could not rotate the secret", {
                          description: result.error,
                        })
                        return
                      }
                      setRotated(result.data)
                      router.refresh()
                    }}
                  >
                    <KeyRound />
                    Rotate signing secret
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeleting(endpoint)}
                  >
                    <Trash2 />
                    Delete endpoint
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex flex-wrap gap-1 border-t px-4 py-2.5">
              {endpoint.events.length === 0 ? (
                // ⚠ AN ENDPOINT WITH NO EVENTS RECEIVES NOTHING, AND THAT IS
                // WORTH SAYING OUT LOUD. It is indistinguishable from a broken
                // handler from the customer's side.
                <span className="text-xs text-warning">
                  Subscribed to no events — this endpoint will never be called.
                </span>
              ) : (
                endpoint.events.map((event) => (
                  <Badge key={event} variant="outline" className="font-mono text-2xs">
                    {event}
                  </Badge>
                ))
              )}
            </div>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this endpoint?"
        description="Events stop being delivered to it immediately. Past delivery attempts stay in the log."
        confirmLabel="Delete endpoint"
        onConfirm={async () => {
          if (!deleting) return false
          const result = await deleteWebhook(deleting.id)
          if (!result.ok) {
            toast.error("Could not delete the endpoint", { description: result.error })
            return false
          }
          toast.success("Endpoint deleted")
          setDeleting(null)
          router.refresh()
          return true
        }}
      />

      <Dialog open={rotated !== null} onOpenChange={() => {}}>
        <DialogContent
          className="sm:max-w-lg"
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Your new signing secret</DialogTitle>
            <DialogDescription>
              The previous secret stopped verifying the moment this was issued.
              Deploy it before the next event arrives, or your handler will reject
              a legitimate request.
            </DialogDescription>
          </DialogHeader>
          {rotated?.secret && <CopyField value={rotated.secret} className="py-2" />}
          <DialogFooter>
            <Button onClick={() => setRotated(null)}>I have copied it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
