"use client"

import * as React from "react"
import {
  Copy,
  Inbox,
  KeyRound,
  Layers,
  Pause,
  Play,
  SearchX,
  Trash2,
  Webhook,
} from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { DropdownMenuItem, DropdownMenuSeparator } from "@repo/ui/components/i10/menu"
import { Tooltip } from "@repo/ui/components/tooltip/tooltip"
import { ListCard, ListGrid, MotionBody, MotionRow } from "@/components/list/motion"
import {
  ListCell,
  ListHead,
  ListHeader,
  ListTable,
  selectedRowClass,
} from "@/components/list/table"
import { BulkBar } from "@/components/list/bulk-bar"
import { forEachPicked, useListSelection } from "@/components/list/selection"
import {
  FilterSelect,
  ListToolbar,
  ResultsLine,
  SearchField,
  ViewToggle,
  useRememberedView,
} from "@/components/list/toolbar"
import { Status } from "@/components/status"
import { ConfirmDialog, confirmWordFor } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import {
  deleteWebhook,
  revokePreviousWebhookSecrets,
  updateWebhook,
} from "@/lib/actions"
import { RotateSecretDialog } from "@/components/webhook-rotate-dialog"
import type { WebhookEndpoint, WebhookStats } from "@/lib/types"
import {
  KIND_LABEL,
  STATE_LABEL,
  endpointName,
  endpointState,
  errorRate,
  formatErrorRate,
  rateTone,
  type EndpointState,
} from "@/lib/webhooks"
import { Time } from "@/components/time"
import { toastDone, toastError } from "@/lib/toast"
import { RowMenu } from "@/components/list/row-menu"
import Link from "next/link"
import { cn } from "cn"

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
 *
 * ⚠ THE ERROR RATE IS OVER THE LAST 24 HOURS AND COUNTS ATTEMPTS, retries
 * included (#300): a receiver that only answers on the third try is shown as
 * the problem it is. An endpoint with no traffic shows a dash, not 0%.
 */
export function WebhookList({
  endpoints,
  stats,
}: {
  endpoints: WebhookEndpoint[]
  /** The last 24 hours across the workspace; null when it could not be read. */
  stats: WebhookStats | null
}) {
  const [deleting, setDeleting] = React.useState<WebhookEndpoint | null>(null)
  const [rotating, setRotating] = React.useState<WebhookEndpoint | null>(null)

  const [query, setQuery] = React.useState("")
  const [state, setState] = React.useState("")
  const [view, setView] = useRememberedView("webhooks", "grid")

  const q = query.trim().toLowerCase()
  const shown = endpoints.filter(
    (e) =>
      (!q ||
        endpointName(e).toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q) ||
        e.events.some((event) => event.includes(q))) &&
      (!state || endpointState(e) === state),
  )
  const selection = useListSelection(shown, (e) => e.id)
  const { picked } = selection
  const [bulkDeleting, setBulkDeleting] = React.useState<WebhookEndpoint[] | null>(null)
  const [bulkBusy, setBulkBusy] = React.useState(false)

  if (endpoints.length === 0) {
    return (
      <EmptyState
        icon={<Webhook />}
        title="No endpoints yet"
        description="Add one to receive delivery, bounce and complaint events as they happen: posted to your URL, sent to an SQS queue, or waiting for you to fetch."
      />
    )
  }

  const rates = new Map(
    (stats?.by_endpoint ?? []).map((row) => [
      row.endpoint_id,
      errorRate(row.attempts, row.failed_attempts),
    ]),
  )

  const clear = () => {
    setQuery("")
    setState("")
  }

  const setEnabled = async (endpoint: WebhookEndpoint, enabled: boolean) => {
    const result = await updateWebhook(endpoint.id, { enabled })
    if (!result.ok) {
      toastError(
        enabled ? "Could not resume the endpoint" : "Could not pause the endpoint",
        {
          description: result.error,
        },
      )
      return
    }
    toastDone(enabled ? "Endpoint resumed" : "Endpoint paused")
  }

  /** Pause or resume every ticked endpoint that is not already that way. */
  async function bulkEnable(enabled: boolean) {
    const targets = picked.filter((e) => e.enabled !== enabled)
    if (bulkBusy || targets.length === 0) return
    setBulkBusy(true)
    const { done, failed } = await forEachPicked(targets, (e) =>
      updateWebhook(e.id, { enabled }),
    )
    setBulkBusy(false)
    const noun = (n: number) => (n === 1 ? "endpoint" : "endpoints")
    if (done === 0)
      toastError(
        enabled ? "Could not resume the endpoints" : "Could not pause the endpoints",
      )
    else
      toastDone(
        `${enabled ? "Resumed" : "Paused"} ${done} ${noun(done)}`,
        failed > 0 ? `${failed} could not be changed` : undefined,
      )
  }

  const menu = (endpoint: WebhookEndpoint) => (
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
      {endpoint.kind !== "polling" && (
        <DropdownMenuItem onSelect={() => setRotating(endpoint)}>
          <KeyRound />
          Rotate signing secret
        </DropdownMenuItem>
      )}
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
      {endpoint.enabled ? (
        <DropdownMenuItem onSelect={() => void setEnabled(endpoint, false)}>
          <Pause />
          Pause endpoint
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={() => void setEnabled(endpoint, true)}>
          <Play />
          {endpoint.health === "disabled" ? "Turn back on" : "Resume endpoint"}
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
          options={(["healthy", "failing", "disabled", "paused"] as const).map(
            (value) => ({ value, label: STATE_LABEL[value] }),
          )}
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
              <Button size="sm" variant="secondary" onClick={clear}>
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
                href={`/webhooks/${endpoint.id}`}
                menu={menu(endpoint)}
                muted={!endpoint.enabled && endpoint.health !== "disabled"}
                select={selection.rowBox(endpoint, `Select ${endpointName(endpoint)}`)}
                selected={selection.isTicked(endpoint)}
                selecting={picked.length > 0}
              >
                <div className="flex min-w-0 items-center gap-3 pr-20">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-muted/50 text-muted-foreground transition-colors group-hover:text-foreground">
                    <KindIcon kind={endpoint.kind} />
                  </span>
                  <div className="min-w-0">
                    <p
                      className="truncate font-mono text-sm"
                      title={endpointName(endpoint)}
                    >
                      {endpointName(endpoint)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {KIND_LABEL[endpoint.kind]}
                      {endpoint.description && ` · ${endpoint.description}`}
                    </p>
                  </div>
                </div>
                <Events events={endpoint.events} />
                <PreviousSecrets endpoint={endpoint} />
                {endpoint.health === "disabled" && endpoint.disabled_reason && (
                  <p className="text-xs text-danger">
                    Switched off by i10: {endpoint.disabled_reason}
                  </p>
                )}
                <div className="mt-auto flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <EndpointStatus state={endpointState(endpoint)} />
                  <ErrorRate rate={rates.get(endpoint.id) ?? null} />
                </div>
              </ListCard>
            ))}
          </ListGrid>
        ) : (
          <ListTable>
            <ListHeader>
              <th className="w-10 py-2.5 pl-4">
                {selection.headerBox("Select all endpoints")}
              </th>
              <ListHead className="pl-0">Endpoint</ListHead>
              <ListHead className="w-[9rem]">Status</ListHead>
              <ListHead className="hidden w-[7rem] sm:table-cell">Kind</ListHead>
              <ListHead className="hidden md:table-cell">Events</ListHead>
              <ListHead className="w-[7rem] text-right">Error rate</ListHead>
              <ListHead className="w-12">
                <span className="sr-only">Actions</span>
              </ListHead>
            </ListHeader>
            <MotionBody>
              {shown.map((endpoint) => (
                <MotionRow
                  key={endpoint.id}
                  href={`/webhooks/${endpoint.id}`}
                  className={cn(
                    !endpoint.enabled && endpoint.health !== "disabled" && "opacity-60",
                    selection.isTicked(endpoint) && selectedRowClass,
                  )}
                >
                  <td className="w-10 py-3 pl-4">
                    {selection.rowBox(endpoint, `Select ${endpointName(endpoint)}`)}
                  </td>
                  <ListCell className="max-w-0 pl-0">
                    <Link
                      href={`/webhooks/${endpoint.id}`}
                      className="block truncate font-mono text-xs outline-none hover:underline focus-visible:underline"
                      title={endpointName(endpoint)}
                    >
                      {endpointName(endpoint)}
                    </Link>
                    {endpoint.description && (
                      <p className="truncate text-xs text-muted-foreground">
                        {endpoint.description}
                      </p>
                    )}
                  </ListCell>
                  <ListCell>
                    <EndpointStatus state={endpointState(endpoint)} />
                  </ListCell>
                  <ListCell className="hidden text-xs text-muted-foreground sm:table-cell">
                    {KIND_LABEL[endpoint.kind]}
                  </ListCell>
                  <ListCell className="hidden md:table-cell">
                    <Events events={endpoint.events} compact />
                  </ListCell>
                  <ListCell className="text-right text-xs">
                    <ErrorRate rate={rates.get(endpoint.id) ?? null} bare />
                  </ListCell>
                  <ListCell className="py-1.5 text-right">{menu(endpoint)}</ListCell>
                </MotionRow>
              ))}
            </MotionBody>
          </ListTable>
        )}
      </div>

      <BulkBar
        count={picked.length}
        onClear={selection.clear}
        label="Selected endpoints"
      >
        {picked.some((e) => e.enabled) && (
          <Button
            variant="ghost"
            size="sm"
            loading={bulkBusy}
            onClick={() => void bulkEnable(false)}
          >
            <Pause />
            Pause
          </Button>
        )}
        {picked.some((e) => !e.enabled) && (
          <Button
            variant="ghost"
            size="sm"
            loading={bulkBusy}
            onClick={() => void bulkEnable(true)}
          >
            <Play />
            Resume
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void navigator.clipboard
              .writeText(picked.map((e) => endpointName(e)).join("\n"))
              .then(
                () =>
                  toastDone(
                    picked.length === 1
                      ? "Endpoint address copied"
                      : "Endpoint addresses copied",
                  ),
                () => toastError("Could not copy the addresses"),
              )
          }
        >
          <Copy />
          Copy addresses
        </Button>
        <Button variant="danger" size="sm" onClick={() => setBulkDeleting(picked)}>
          <Trash2 />
          Delete
        </Button>
      </BulkBar>

      <ConfirmDialog
        open={bulkDeleting !== null}
        onOpenChange={(open) => !open && setBulkDeleting(null)}
        title={
          (bulkDeleting?.length ?? 0) === 1
            ? "Delete this endpoint?"
            : `Delete ${bulkDeleting?.length ?? 0} endpoints?`
        }
        description="Events stop being delivered to them immediately. Past delivery attempts stay in the log."
        confirmLabel={
          (bulkDeleting?.length ?? 0) === 1 ? "Delete endpoint" : "Delete endpoints"
        }
        doneLabel="Deleted"
        confirmWord={confirmWordFor((bulkDeleting ?? []).map(endpointName))}
        onConfirm={async () => {
          if (!bulkDeleting) return false
          const { done, failed } = await forEachPicked(bulkDeleting, (e) =>
            deleteWebhook(e.id),
          )
          if (failed > 0)
            toastError(
              done === 0
                ? "Could not delete the endpoints"
                : `Deleted ${done}, ${failed} could not be deleted`,
            )
          selection.clear()
          return done > 0
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this endpoint?"
        description="Events stop being delivered to it immediately. Past delivery attempts stay in the log."
        confirmLabel="Delete endpoint"
        doneLabel="Deleted"
        confirmWord={confirmWordFor(deleting ? [endpointName(deleting)] : [])}
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

export function KindIcon({
  kind,
  className,
}: {
  kind: WebhookEndpoint["kind"]
  className?: string
}) {
  const Icon = kind === "polling" ? Inbox : kind === "sqs" ? Layers : Webhook
  return <Icon className={className ?? "size-4"} />
}

/** Where an endpoint stands, in the same words as its page. */
export function EndpointStatus({ state }: { state: EndpointState }) {
  return (
    <Status
      status={state === "disabled" ? "failed" : state === "paused" ? "disabled" : state}
      label={STATE_LABEL[state]}
    />
  )
}

function ErrorRate({ rate, bare = false }: { rate: number | null; bare?: boolean }) {
  const tone = rateTone(rate)
  const value = (
    <span
      className={cn(
        "tabular",
        tone === "danger" && "text-danger",
        tone === "warning" && "text-warning",
        !tone && rate !== null && "text-foreground",
      )}
    >
      {formatErrorRate(rate)}
    </span>
  )
  if (bare) return value
  return <span>{value} errors, 24h</span>
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
    // ⚠ ONE LINE IN A ROW. A wrapping list's minimum width is its widest
    // chip, so beside a column that takes the free width it stacked the
    // chips three high.
    <div
      className={cn("flex items-center gap-1", compact ? "flex-nowrap" : "flex-wrap")}
    >
      {shown.map((event) => (
        <Badge size="sm" key={event} tone="neutral">
          {event}
        </Badge>
      ))}
      {rest > 0 && (
        <Tooltip content={events.slice(2).join(", ")}>
          <Badge size="sm" tone="neutral">
            +{rest}
          </Badge>
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
