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
import { Bone, BoneRegion, BoneScope } from "@repo/ui/components/bone/bone"
import { Button } from "@repo/ui/components/button/button"
import { DropdownMenuItem, DropdownMenuSeparator } from "@repo/ui/components/i10/menu"
import { Tooltip } from "@repo/ui/components/tooltip/tooltip"
import {
  ListCard,
  ListGrid,
  MotionBody,
  MotionRow,
  StaticCard,
  StaticGrid,
} from "@/components/list/motion"
import {
  ListBody,
  ListCell,
  ListHead,
  ListHeader,
  ListRow,
  ListTable,
  selectedRowClass,
} from "@/components/list/table"
import { BulkBar } from "@/components/list/bulk-bar"
import { forEachPicked, useListSelection } from "@/components/list/selection"
import { seedShape } from "@/components/list/remembered-shapes"
import { webhookDetailShape } from "@/lib/shapes/webhook-detail"
import {
  FilterSelect,
  ListResults,
  ListSearch,
  ListToolbar,
  ListToolbarEnd,
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

const NAME_WIDTHS = ["62%", "48%", "72%", "55%"]

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
  count = 3,
  shapeView,
  loading = false,
}: {
  endpoints?: WebhookEndpoint[]
  /** The last 24 hours across the workspace; null when it could not be read. */
  stats?: WebhookStats | null
  count?: number
  shapeView?: "grid" | "table"
  loading?: boolean
}) {
  const isLoaded = !loading && endpoints !== undefined
  const [deleting, setDeleting] = React.useState<WebhookEndpoint | null>(null)
  const [rotating, setRotating] = React.useState<WebhookEndpoint | null>(null)

  const [query, setQuery] = React.useState("")
  const [state, setState] = React.useState("")
  const [view, setView] = useRememberedView("webhooks", shapeView ?? "grid")
  // ⚠ THE CHOSEN VIEW IN BOTH MODES, as every other list (2026-11-18). The
  // shape's view is only the server's guess when nothing was chosen; drawn
  // from it while loading, the skeleton was a grid for a table chosen since.
  const effectiveView = view

  const q = query.trim().toLowerCase()
  const shown = (endpoints ?? []).filter(
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

  const seedEndpoint = React.useCallback((e: WebhookEndpoint) => {
    seedShape(webhookDetailShape, e.id, {
      kind: e.kind,
      tab: "overview",
      state: endpointState(e),
      notice:
        e.health === "disabled"
          ? "disabled"
          : !e.enabled
            ? "paused"
            : e.health === "failing"
              ? "failing"
              : "none",
      deliveries: 5,
      replays: 0,
      health: e.health === "healthy" ? 0 : 1,
      described: Boolean(e.description),
      events: 0,
    })
  }, [])

  React.useEffect(() => {
    for (const e of endpoints ?? []) {
      seedEndpoint(e)
    }
  }, [endpoints, seedEndpoint])

  if (isLoaded && endpoints.length === 0) {
    return (
      <EmptyState
        icon={<Webhook />}
        title="No endpoints yet"
        description="Add one to receive delivery, bounce and complaint events as they happen: posted to your URL, sent to an SQS queue, or waiting for you to fetch."
      />
    )
  }

  if (!isLoaded && count === 0) {
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

  const rows: (WebhookEndpoint | undefined)[] = isLoaded
    ? shown
    : Array.from({ length: count }, () => undefined)
  const Grid = isLoaded ? ListGrid : StaticGrid
  const Body = isLoaded ? MotionBody : ListBody
  const RowEl = isLoaded ? MotionRow : ListRow

  return (
    <>
      <ListToolbar>
        <ListSearch
          value={query}
          onChange={setQuery}
          placeholder="Search endpoints or events"
          label="Search endpoints"
        />
        <ListResults
          count={shown.length}
          query={query}
          filtered={state !== ""}
          noun={["endpoint", "endpoints"]}
          onClear={clear}
        />
        <ListToolbarEnd>
          <FilterSelect
            value={state}
            onValueChange={setState}
            label="State"
            allLabel="All endpoints"
            options={(["healthy", "failing", "disabled", "paused"] as const).map(
              (value) => ({ value, label: STATE_LABEL[value] }),
            )}
          />
          <ViewToggle value={effectiveView} onChange={setView} />
        </ListToolbarEnd>
      </ListToolbar>

      <div className="pt-4">
        <BoneRegion id="endpoints">
          {isLoaded && shown.length === 0 ? (
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
          ) : effectiveView === "grid" ? (
            <Grid className="lg:grid-cols-2 2xl:grid-cols-3">
              {rows.map((endpoint, i) => {
                const body = (
                  <>
                    <div
                      className="flex min-w-0 items-center gap-3 pr-20"
                      onPointerEnter={() => {
                        if (endpoint) seedEndpoint(endpoint)
                      }}
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-muted/50 text-muted-foreground transition-colors group-hover:text-foreground">
                        <Bone
                          id="kind-icon"
                          shape="box"
                          width={16}
                          height={16}
                          radius={4}
                          inline
                        >
                          {endpoint && <KindIcon kind={endpoint.kind} />}
                        </Bone>
                      </span>
                      <div className="min-w-0">
                        <Bone
                          id="name"
                          width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                          lineHeight={20}
                          className="font-mono text-sm"
                        >
                          {endpoint && (
                            <p
                              className="truncate font-mono text-sm"
                              title={endpointName(endpoint)}
                            >
                              {endpointName(endpoint)}
                            </p>
                          )}
                        </Bone>
                        <Bone
                          id="desc"
                          width={140}
                          lineHeight={16}
                          className="text-xs text-muted-foreground"
                        >
                          {endpoint && (
                            <p className="truncate text-xs text-muted-foreground">
                              {KIND_LABEL[endpoint.kind]}
                              {endpoint.description && ` · ${endpoint.description}`}
                            </p>
                          )}
                        </Bone>
                      </div>
                    </div>
                    <Bone
                      id="events"
                      shape="box"
                      width={180}
                      height={22}
                      radius={9999}
                      inline
                    >
                      {endpoint && <Events events={endpoint.events} limit={2} />}
                    </Bone>
                    {/*
                     * ⚠ ONE LINE, ALWAYS THERE (2026-11-19), so every card is one
                     * height and the skeleton's is the same. It says one thing about
                     * one endpoint (a switch-off, a rotation still signing); most have
                     * neither, so the skeleton keeps it empty rather than draw a bar
                     * that would be wrong more often than right.
                     */}
                    <div className="h-4 min-w-0">
                      {endpoint && <CardNote endpoint={endpoint} />}
                    </div>
                    <div className="mt-auto flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <Bone
                        id="status"
                        shape="box"
                        width={76}
                        height={20}
                        radius={9999}
                        inline
                      >
                        {endpoint && <EndpointStatus state={endpointState(endpoint)} />}
                      </Bone>
                      <Bone id="error-rate" width={90} lineHeight={16} inline>
                        {endpoint && (
                          <ErrorRate rate={rates.get(endpoint.id) ?? null} />
                        )}
                      </Bone>
                    </div>
                  </>
                )
                return (
                  <BoneScope key={endpoint?.id ?? i} id={`endpoint-${i}`} unit>
                    {endpoint ? (
                      <ListCard
                        id={endpoint.id}
                        href={`/webhooks/${endpoint.id}`}
                        menu={menu(endpoint)}
                        muted={!endpoint.enabled && endpoint.health !== "disabled"}
                        select={selection.rowBox(
                          endpoint,
                          `Select ${endpointName(endpoint)}`,
                        )}
                        selected={selection.isTicked(endpoint)}
                        selecting={picked.length > 0}
                      >
                        {body}
                      </ListCard>
                    ) : (
                      <StaticCard>{body}</StaticCard>
                    )}
                  </BoneScope>
                )
              })}
            </Grid>
          ) : (
            <ListTable>
              <ListHeader>
                <th className="w-[4.25rem] py-2.5 pl-4">
                  <Bone
                    id="all"
                    shape="box"
                    width={36}
                    height={36}
                    inset={9}
                    radius={5}
                    inline
                  >
                    {isLoaded && selection.headerBox("Select all endpoints")}
                  </Bone>
                </th>
                <ListHead className="pl-0">Endpoint</ListHead>
                {/* F = 384 (tick 68, Status 160, Error rate 96, actions 60): Kind 104 -> 708 -> md (832); Events 224 -> 932 -> xl (1056). */}
                <ListHead className="w-[10rem]">Status</ListHead>
                <ListHead hideBelow="md" className="w-[6.5rem]">
                  Kind
                </ListHead>
                <ListHead hideBelow="xl" className="w-[14rem]">
                  Events
                </ListHead>
                <ListHead className="w-[6rem] text-right">Error rate</ListHead>
                <ListHead className="w-[3.75rem]">
                  <span className="sr-only">Actions</span>
                </ListHead>
              </ListHeader>
              <Body>
                {rows.map((endpoint, i) => {
                  const ticked = endpoint !== undefined && selection.isTicked(endpoint)
                  const href = endpoint ? `/webhooks/${endpoint.id}` : undefined
                  return (
                    <BoneScope key={endpoint?.id ?? i} id={`endpoint-${i}`} unit>
                      <RowEl
                        clickable
                        muted={
                          endpoint !== undefined &&
                          !endpoint.enabled &&
                          endpoint.health !== "disabled"
                        }
                        {...(href ? { href } : {})}
                        className={cn(ticked && selectedRowClass)}
                        onClick={() => {
                          if (endpoint) seedEndpoint(endpoint)
                        }}
                      >
                        <td className="w-[4.25rem] py-3 pl-4">
                          <Bone
                            id="tick"
                            shape="box"
                            width={36}
                            height={36}
                            inset={9}
                            radius={5}
                            inline
                          >
                            {endpoint &&
                              selection.rowBox(
                                endpoint,
                                `Select ${endpointName(endpoint)}`,
                              )}
                          </Bone>
                        </td>
                        <ListCell className="pl-0">
                          <Bone
                            id="name"
                            width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                            lineHeight={16}
                          >
                            {endpoint && (
                              <>
                                <Link
                                  href={`/webhooks/${endpoint.id}`}
                                  className="block truncate font-mono text-xs outline-none hover:underline focus-visible:underline"
                                  title={endpointName(endpoint)}
                                  onPointerEnter={() => seedEndpoint(endpoint)}
                                >
                                  {endpointName(endpoint)}
                                </Link>
                                {/* Optional, so inside the bone: a skeleton cannot know which rows have one. */}
                                {endpoint.description && (
                                  <p
                                    className="truncate text-xs text-muted-foreground"
                                    title={endpoint.description}
                                  >
                                    {endpoint.description}
                                  </p>
                                )}
                              </>
                            )}
                          </Bone>
                        </ListCell>
                        <ListCell>
                          <Bone
                            id="status"
                            shape="box"
                            width={76}
                            height={20}
                            radius={9999}
                            inline
                          >
                            {endpoint && (
                              <EndpointStatus state={endpointState(endpoint)} />
                            )}
                          </Bone>
                        </ListCell>
                        <ListCell
                          hideBelow="md"
                          className="text-xs text-muted-foreground"
                        >
                          <Bone id="kind" width={48} lineHeight={16}>
                            {endpoint && KIND_LABEL[endpoint.kind]}
                          </Bone>
                        </ListCell>
                        <ListCell hideBelow="xl">
                          <Bone
                            id="events"
                            shape="box"
                            width={120}
                            height={20}
                            radius={9999}
                            inline
                          >
                            {endpoint && <Events events={endpoint.events} limit={1} />}
                          </Bone>
                        </ListCell>
                        <ListCell className="text-right text-xs">
                          <Bone id="error-rate" width={40} lineHeight={16} align="end">
                            {endpoint && (
                              <ErrorRate rate={rates.get(endpoint.id) ?? null} bare />
                            )}
                          </Bone>
                        </ListCell>
                        <ListCell className="py-1.5 text-right">
                          {endpoint && menu(endpoint)}
                        </ListCell>
                      </RowEl>
                    </BoneScope>
                  )
                })}
              </Body>
            </ListTable>
          )}
        </BoneRegion>
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
 * What an endpoint listens for: the first `limit` and a count, on one line
 * whose height never changes (a card's height must not depend on its events).
 * The whole list is in the title and the count's tooltip.
 *
 * ⚠ AN ENDPOINT WITH NO EVENTS RECEIVES NOTHING, AND THAT IS WORTH SAYING OUT
 * LOUD. It is indistinguishable from a broken handler from the customer's side.
 */
function Events({ events, limit }: { events: string[]; limit: number }) {
  if (events.length === 0) {
    return (
      <span className="flex h-[22px] min-w-0 items-center truncate text-xs text-warning">
        Subscribed to no events - this endpoint is never called.
      </span>
    )
  }
  const shown = events.slice(0, limit)
  const rest = events.length - shown.length
  return (
    // ⚠ ONE LINE. A wrapping list's minimum width is its widest chip, so beside
    // a column that takes the free width it stacked the chips three high; in a
    // card it made every card a different height from its skeleton.
    <div
      className="flex h-[22px] min-w-0 flex-nowrap items-center gap-1"
      title={events.join(", ")}
    >
      {shown.map((event) => (
        <Badge size="sm" key={event} tone="neutral">
          {event}
        </Badge>
      ))}
      {rest > 0 && (
        <Tooltip content={events.slice(limit).join(", ")}>
          <Badge size="sm" tone="neutral" className="shrink-0">
            +{rest}
          </Badge>
        </Tooltip>
      )}
    </div>
  )
}

/**
 * A card's one line about its endpoint: a switch-off first, else a rotation
 * still signing, else nothing.
 *
 * ⚠ SKIPPED BY test/skeleton-parity: it exists only for some endpoints, and its
 * line is reserved in both trees by the card.
 */
function CardNote({ endpoint }: { endpoint: WebhookEndpoint }) {
  if (endpoint.health === "disabled" && endpoint.disabled_reason) {
    const text = `Switched off: ${endpoint.disabled_reason}`
    return (
      <p className="truncate text-xs text-danger" title={text} data-skeleton="skip">
        {text}
      </p>
    )
  }
  return <PreviousSecrets endpoint={endpoint} />
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
    <p
      className="flex min-w-0 items-center gap-1.5 text-xs text-warning"
      data-skeleton="skip"
    >
      <KeyRound className="size-3.5 shrink-0" />
      <span className="truncate">
        {endpoint.previous_secrets.length === 1
          ? "A previous secret"
          : `${endpoint.previous_secrets.length} previous secrets`}{" "}
        still {endpoint.previous_secrets.length === 1 ? "signs" : "sign"} until{" "}
        <Time iso={last} mode="exact" />
      </span>
    </p>
  )
}
