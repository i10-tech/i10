"use client"

import * as React from "react"
import { Copy, KeyRound, MoreHorizontal, SearchX, Trash2, Webhook } from "lucide-react"
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { ListCard, ListGrid, MotionBody, MotionRow } from "@/components/list/motion"
import {
  ListCell,
  ListHead,
  ListHeader,
  ListTable,
  rowMenuClass,
} from "@/components/list/table"
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
import { deleteWebhook, rotateWebhookSecret } from "@/lib/actions"
import { useRetained } from "@/lib/react"
import type { WebhookEndpoint } from "@/lib/types"
import { Time } from "@/components/time"

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
  const [rotated, setRotated] = React.useState<WebhookEndpoint | null>(null)
  const shownRotated = useRetained(rotated)

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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={rowMenuClass}
          aria-label={`Actions for ${endpoint.url}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          onSelect={() =>
            void navigator.clipboard.writeText(endpoint.id).then(
              () => toast.success("Endpoint ID copied"),
              () => toast.error("Could not copy the ID"),
            )
          }
        >
          <Copy />
          Copy ID
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            const result = await rotateWebhookSecret(endpoint.id)
            if (!result.ok) {
              toast.error("Could not rotate the secret", { description: result.error })
              return
            }
            // No refresh: `rotateWebhookSecret` re-renders this page in its own
            // response. See `run` in lib/actions.ts.
            setRotated(result.data)
          }}
        >
          <KeyRound />
          Rotate signing secret
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(endpoint)}>
          <Trash2 />
          Delete endpoint
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
            toast.error("Could not delete the endpoint", { description: result.error })
            return false
          }
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
              The previous secret stopped verifying the moment this was issued. Deploy
              it before the next event arrives, or your handler will reject a legitimate
              request.
            </DialogDescription>
          </DialogHeader>
          {shownRotated?.secret && (
            <CopyField value={shownRotated.secret} className="py-2" />
          )}
          <DialogFooter>
            <Button onClick={() => setRotated(null)}>I have copied it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
