"use client"

import * as React from "react"
import { Copy, KeyRound, SearchX, Trash2, Webhook } from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@repo/ui/components/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { ListCard, ListGrid, MotionBody, MotionRow } from "@/components/list/motion"
import { ListCell, ListHead, ListHeader, ListTable } from "@/components/list/table"
import {
  FilterSelect,
  ListToolbar,
  ResultsLine,
  SearchField,
  ViewToggle,
  useRememberedView,
} from "@/components/list/toolbar"
import { Status } from "@/components/status"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { deleteWebhook, revokePreviousWebhookSecrets } from "@/lib/actions"
import { RotateSecretDialog } from "@/components/webhook-rotate-dialog"
import type { WebhookEndpoint } from "@/lib/types"
import { Time } from "@/components/time"
import { toastDone, toastError } from "@/lib/toast"
import { RowMenu } from "@/components/list/row-menu"

/**
 * The endpoints, as cards rather than a table.
 *
 * ⚠ CARDS BY DEFAULT, A TABLE ON REQUEST. A CARD PER ENDPOINT, BECAUSE THE EVENT LIST IS THE INTERESTING PART AND IT
 * DOES NOT FIT IN A CELL. Six event names is 80-odd characters; in a table
 * column that is either truncated - hiding the exact thing somebody is checking
 * - or it forces the URL column down to nothing. Most accounts have one to three
 * endpoints, so a list of cards costs no scrolling.
 *
 * ⚠ AND A DISABLED ENDPOINT SAYS SO LOUDLY. The API disables an endpoint after
 * repeated failures; from the customer's side their handler simply stopped
 * being called, with nothing to explain it. This badge is the explanation.
 */
export function WebhookList({ endpoints }: { endpoints: WebhookEndpoint[] }) {
  const [deleting, setDeleting] = React.useState<WebhookEndpoint | null>(null)
  const [rotating, setRotating] = React.useState<WebhookEndpoint | null>(null)

  const [query, setQuery] = React.useState("")
  const [state, setState] = React.useState("")
  const [view, setView] = useRememberedView("webhooks", "grid")

  if (endpoints.length === 0) {
    return (
      <EmptyState
        icon={<Webhook />}
        title="No endpoints yet"
        description="Add one to receive delivery, bounce and complaint events as they happen - rather than polling for them."
      />
    )
  }

  const q = query.trim().toLowerCase()
  const shown = endpoints.filter(
    (e) =>
      (!q ||
        e.url.toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q) ||
        e.events.some((event) => event.includes(q))) &&
      (!state || (state === "enabled") === e.enabled),
  )
  const clear = () => {
    setQuery("")
    setState("")
  }

  const menu = (endpoint: WebhookEndpoint) => (
    <RowMenu label={endpoint.url}>
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
      {endpoint.public_key && (
        <DropdownMenuItem
          onSelect={() =>
            void navigator.clipboard.writeText(endpoint.public_key!).then(
              () => toastDone("Public key copied"),
              () => toastError("Could not copy the public key"),
            )
          }
        >
          <Copy />
          Copy public key
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={() => setRotating(endpoint)}>
        <KeyRound />
        Rotate signing secret
      </DropdownMenuItem>
      {endpoint.previous_secrets.length > 0 && (
        <DropdownMenuItem
          onSelect={async () => {
            const result = await revokePreviousWebhookSecrets(endpoint.id)
            if (!result.ok) {
              toastError("Could not revoke the previous secrets", {
                description: result.error,
              })
              return
            }
            toastDone("Previous secrets revoked")
          }}
        >
          <KeyRound />
          Revoke previous secrets now
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(endpoint)}>
        <Trash2 />
        Delete endpoint
      </DropdownMenuItem>
    </RowMenu>
  )

  return (
    <>
      <ListToolbar>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search endpoints or events"
          label="Search endpoints"
        />
        <FilterSelect
          value={state}
          onValueChange={setState}
          label="State"
          allLabel="All endpoints"
          options={[
            { value: "enabled", label: "Enabled" },
            { value: "disabled", label: "Disabled" },
          ]}
        />
        <ViewToggle value={view} onChange={setView} />
      </ListToolbar>
      <ResultsLine
        count={shown.length}
        query={query}
        filtered={state !== ""}
        noun={["endpoint", "endpoints"]}
        onClear={clear}
      />

      <div className="pt-4">
        {shown.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title="No endpoint matches"
            description="Try another address or event, or clear the filters."
            secondary={
              <Button size="sm" variant="outline" onClick={clear}>
                Clear filters
              </Button>
            }
          />
        ) : view === "grid" ? (
          <ListGrid className="lg:grid-cols-2 2xl:grid-cols-3">
            {shown.map((endpoint) => (
              <ListCard
                key={endpoint.id}
                id={endpoint.id}
                menu={menu(endpoint)}
                muted={!endpoint.enabled}
              >
                <div className="flex min-w-0 items-center gap-3 pr-8">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-muted/50 text-muted-foreground transition-colors group-hover:text-foreground">
                    <Webhook className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm" title={endpoint.url}>
                      {endpoint.url}
                    </p>
                    {endpoint.description && (
                      <p className="truncate text-xs text-muted-foreground">
                        {endpoint.description}
                      </p>
                    )}
                  </div>
                </div>
                <Events events={endpoint.events} />
                <PreviousSecrets endpoint={endpoint} />
                <div className="mt-auto flex items-center justify-between text-xs text-muted-foreground">
                  <Status status={endpoint.enabled ? "enabled" : "disabled"} />
                  <span>
                    Added <Time iso={endpoint.created_at} />
                  </span>
                </div>
              </ListCard>
            ))}
          </ListGrid>
        ) : (
          <ListTable>
            <ListHeader>
              <ListHead>Endpoint</ListHead>
              <ListHead className="w-[9rem]">Status</ListHead>
              <ListHead className="hidden md:table-cell">Events</ListHead>
              <ListHead className="w-[9rem] text-right">Added</ListHead>
              <ListHead className="w-12">
                <span className="sr-only">Actions</span>
              </ListHead>
            </ListHeader>
            <MotionBody>
              {shown.map((endpoint) => (
                <MotionRow
                  key={endpoint.id}
                  className={endpoint.enabled ? undefined : "opacity-60"}
                >
                  <ListCell className="max-w-0">
                    <p className="truncate font-mono text-xs" title={endpoint.url}>
                      {endpoint.url}
                    </p>
                    {endpoint.description && (
                      <p className="truncate text-xs text-muted-foreground">
                        {endpoint.description}
                      </p>
                    )}
                  </ListCell>
                  <ListCell>
                    <Status status={endpoint.enabled ? "enabled" : "disabled"} />
                  </ListCell>
                  <ListCell className="hidden md:table-cell">
                    <Events events={endpoint.events} compact />
                  </ListCell>
                  <ListCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
                    <Time iso={endpoint.created_at} />
                  </ListCell>
                  <ListCell className="py-1.5 text-right">{menu(endpoint)}</ListCell>
                </MotionRow>
              ))}
            </MotionBody>
          </ListTable>
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this endpoint?"
        description="Events stop being delivered to it immediately. Past delivery attempts stay in the log."
        confirmLabel="Delete endpoint"
        doneLabel="Deleted"
        confirmWord={deleting?.url}
        onConfirm={async () => {
          if (!deleting) return false
          const result = await deleteWebhook(deleting.id)
          if (!result.ok) {
            toastError("Could not delete the endpoint", { description: result.error })
            return false
          }
          return true
        }}
      />

      <RotateSecretDialog
        endpoint={rotating}
        onOpenChange={(open) => !open && setRotating(null)}
      />
    </>
  )
}

/**
 * What an endpoint listens for. In a table row, the first two and a count -
 * the whole list is in the tooltip.
 *
 * ⚠ AN ENDPOINT WITH NO EVENTS RECEIVES NOTHING, AND THAT IS WORTH SAYING OUT
 * LOUD. It is indistinguishable from a broken handler from the customer's side.
 */
function Events({ events, compact = false }: { events: string[]; compact?: boolean }) {
  if (events.length === 0) {
    return (
      <span className="text-xs text-warning">
        Subscribed to no events - this endpoint is never called.
      </span>
    )
  }
  const shown = compact ? events.slice(0, 2) : events
  const rest = events.length - shown.length
  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((event) => (
        <Badge key={event} variant="outline" className="font-mono text-2xs">
          {event}
        </Badge>
      ))}
      {rest > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="secondary" className="cursor-default text-2xs">
              +{rest}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs font-mono text-2xs">
            {events.slice(2).join(", ")}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/**
 * ⚠ A SECRET THAT STILL SIGNS AFTER A ROTATION IS SAID OUT LOUD, with when it
 * stops. It was the person's own choice, but a grace period they forgot about
 * is exactly the window a leaked secret is useful in.
 */
function PreviousSecrets({ endpoint }: { endpoint: WebhookEndpoint }) {
  const last = endpoint.previous_secrets
    .map((p) => p.expires_at)
    .sort()
    .at(-1)
  if (!last) return null
  return (
    <p className="flex items-center gap-1.5 text-xs text-warning">
      <KeyRound className="size-3.5" />
      <span>
        {endpoint.previous_secrets.length === 1
          ? "A previous secret"
          : `${endpoint.previous_secrets.length} previous secrets`}{" "}
        still {endpoint.previous_secrets.length === 1 ? "signs" : "sign"} until{" "}
        <Time iso={last} mode="exact" />
      </span>
    </p>
  )
}
