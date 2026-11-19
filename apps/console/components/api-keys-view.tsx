"use client"

import * as React from "react"
import { cn } from "cn"
import { Copy, Globe, KeyRound, RefreshCw, SearchX, Trash2 } from "lucide-react"
import { Bone, BoneRegion, BoneScope } from "@repo/ui/components/bone/bone"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { DropdownMenuItem, DropdownMenuSeparator } from "@repo/ui/components/i10/menu"
import {
  Page,
  PageActions,
  PageBody,
  PageDescription,
  PageHeader,
  PageHeaderRow,
  PageTitle,
  TITLE,
} from "@repo/ui/components/i10/page"
import { PlaceholderTitle } from "@repo/ui/components/i10/page-title"
import { ApiKeyScopeDialog } from "@/components/api-key-scope"
import { ConfirmDialog, confirmWordFor } from "@/components/confirm-dialog"
import { CreateApiKeyButton } from "@/components/create-api-key"
import { EmptyState } from "@/components/empty-state"
import { ApiButton } from "@/components/list/api-button"
import { BulkBar } from "@/components/list/bulk-bar"
import { MotionBody, MotionRow } from "@/components/list/motion"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import { RowMenu } from "@/components/list/row-menu"
import { forEachPicked, lockedBox, useListSelection } from "@/components/list/selection"
import {
  ListBody,
  ListCell,
  ListHead,
  ListHeader,
  ListRow,
  ListTable,
  selectedRowClass,
} from "@/components/list/table"
import {
  FilterSelect,
  ListResults,
  ListSearch,
  ListToolbar,
  ListToolbarEnd,
} from "@/components/list/toolbar"
import { PanelError } from "@/components/panel-error"
import { Time } from "@/components/time"
import { revokeApiKey, rotateApiKey } from "@/lib/actions"
import { PAGE_COPY } from "@/lib/page-copy"
import { useRetained, NONE } from "@/lib/react"
import {
  apiKeysShape,
  type ApiKeysData,
  type ApiKeysShape,
} from "@/lib/shapes/api-keys"
import { SNIPPETS } from "@/lib/snippets"
import { useStepUp } from "@/lib/step-up"
import { toastDone, toastError } from "@/lib/toast"
import type { ApiKeyRow, CreatedApiKey } from "@/lib/types"

/** What loading.tsx renders: the view with the shape this workspace last had. */
export function ApiKeysLoading() {
  return <ApiKeysView shape={useRememberedShape(apiKeysShape)} />
}

const MODE_OPTIONS = [
  { value: "live", label: "Live" },
  { value: "test", label: "Test" },
]
const STATE_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "revoked", label: "Revoked" },
]

const NAME_WIDTHS = ["62%", "48%", "72%", "55%"]

const createdBy = (key: ApiKeyRow) =>
  key.created_by ? (key.created_by.name ?? key.created_by.email ?? "Unknown") : "Unknown"

/**
 * The key list.
 *
 * The API keys page, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
 *
 * ⚠ REVOKED KEYS STAY IN THE TABLE, GREYED, AT THE BOTTOM, RATHER THAN DISAPPEARING. During an
 * incident the question is "did we revoke that one, and when" - and a key that
 * vanishes on revocation makes that unanswerable from the console. It is also
 * the difference between "I revoked it" and "I think I revoked it".
 *
 * ⚠ AND `last_used_at` IS THE MOST USEFUL COLUMN HERE. A key nothing has
 * touched in months is either dead weight or a credential somebody forgot they
 * issued; both are worth deleting, and neither is visible without this column.
 */
export function ApiKeysView({
  shape,
  data,
}: {
  shape: ApiKeysShape
  data?: ApiKeysData
}) {
  const loading = data === undefined
  const keys = data?.keys ?? NONE
  const domains = data?.domains ?? NONE

  const [scoping, setScoping] = React.useState<ApiKeyRow | null>(null)
  const stepUp = useStepUp()
  const [revoking, setRevoking] = React.useState<ApiKeyRow | null>(null)
  const [rotating, setRotating] = React.useState<ApiKeyRow | null>(null)
  const [rotated, setRotated] = React.useState<CreatedApiKey | null>(null)

  // What the dialogs DISPLAY while they animate out - see `useRetained`.
  const shownRevoking = useRetained(revoking)
  const shownRotating = useRetained(rotating)
  const shownRotated = useRetained(rotated)

  /*
   * ⚠ THE NEW SECRET WAITS FOR THE CONFIRMATION TO LEAVE. It used to be set the
   * instant the rotate returned, which opened the "Your new key" dialog on top
   * of the rotate dialog still standing there - two modals, one over the other,
   * for one click. It is held here and handed over when the first one closes,
   * so the tick is seen, the panel goes, and the secret arrives in its own.
   */
  const issued = React.useRef<CreatedApiKey | null>(null)

  const [query, setQuery] = React.useState("")
  const [mode, setMode] = React.useState("")
  const [state, setState] = React.useState("")
  const q = query.trim().toLowerCase()
  const matching = keys.filter(
    (k) =>
      (!q ||
        k.name.toLowerCase().includes(q) ||
        k.prefix.toLowerCase().includes(q) ||
        k.domains.some((d) => d.includes(q))) &&
      (!mode || k.mode === mode) &&
      (!state || (state === "revoked") === (k.revoked_at !== null)),
  )
  // Live keys first, revoked ones after: the keys somebody can act on stay at
  // the top of the table, each group in the order the API gave.
  const shown = [
    ...matching.filter((k) => k.revoked_at === null),
    ...matching.filter((k) => k.revoked_at !== null),
  ]
  const clear = () => {
    setQuery("")
    setMode("")
    setState("")
  }

  // Only a live key can be acted on; a revoked one stays listed, its box locked.
  const selection = useListSelection(
    shown.filter((k) => k.revoked_at === null && k.can_revoke),
    (k) => k.id,
  )
  const { picked } = selection
  const [bulkRevoking, setBulkRevoking] = React.useState<ApiKeyRow[] | null>(null)

  const hasRows = shape.rows > 0
  const rows: (ApiKeyRow | undefined)[] = loading
    ? Array.from({ length: shape.rows }, () => undefined)
    : shown
  const Body = loading ? ListBody : MotionBody
  const RowEl = loading ? ListRow : MotionRow

  return (
    <BoneScope id="api-keys" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <PageHeaderRow>
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.apiKeys.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.apiKeys.title}</PageTitle>
            )}
            <PageActions>
              {/*
               * ⚠ `?new=1` OPENS THE DIALOG, SO THE COMMAND MENU CAN LINK TO IT.
               * A dialog whose only trigger is a button on one page cannot be
               * reached from ⌘K, from a doc, or from an onboarding step - all
               * three of which want to say "create a key" and land somebody in
               * the form rather than next to it.
               */}
              <ApiButton snippet={SNIPPETS.apiKeys} />
              <CreateApiKeyButton autoOpen={data?.newKey ?? false} domains={domains} />
            </PageActions>
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.apiKeys.description}</PageDescription>
        </PageHeader>

        <PageBody>
          {data?.error !== undefined ? (
            <PanelError title="Could not load your keys" message={data.error} />
          ) : !hasRows ? (
            <EmptyState
              icon={<KeyRound />}
              title="No API keys yet"
              description="Create one and paste it into your server's environment. It is shown once - we store only a hash."
            />
          ) : (
            <div>
              <ListToolbar>
                <ListSearch
                  value={query}
                  onChange={setQuery}
                  placeholder="Search keys"
                  label="Search API keys"
                />
                <ListResults
                  count={shown.length}
                  query={query}
                  filtered={mode !== "" || state !== ""}
                  noun={["key", "keys"]}
                  onClear={clear}
                />
                <ListToolbarEnd>
                  <FilterSelect
                    value={mode}
                    onValueChange={setMode}
                    label="Mode"
                    allLabel="All modes"
                    options={MODE_OPTIONS}
                  />
                  <FilterSelect
                    value={state}
                    onValueChange={setState}
                    label="State"
                    allLabel="Active and revoked"
                    options={STATE_OPTIONS}
                  />
                </ListToolbarEnd>
              </ListToolbar>

              <div className="pt-4">
                <BoneRegion id="list">
                  {!loading && shown.length === 0 ? (
                    <EmptyState
                      icon={<SearchX />}
                      title="No key matches"
                      description="Try another name, or clear the filters."
                      secondary={
                        <Button size="sm" variant="secondary" onClick={clear}>
                          Clear filters
                        </Button>
                      }
                    />
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
                            {!loading && selection.headerBox("Select all live keys")}
                          </Bone>
                        </th>
                        <ListHead className="pl-0">Name</ListHead>
                        <ListHead className="w-[8.5rem]">Key</ListHead>
                        <ListHead className="w-[5rem]">Mode</ListHead>
                        {/*
                         * ⚠ IT EARNS A COLUMN RATHER THAN A BADGE BESIDE THE NAME. "Which
                         * of my keys can reach production" is the question somebody asks
                         * this table during an incident, and a value that is only visible
                         * on the row you happen to be reading does not answer it.
                         */}
                        <ListHead hideBelow="sm" className="w-[8.5rem]">
                          Sends from
                        </ListHead>
                        <ListHead hideBelow="md" className="w-[7rem]">
                          Last used
                        </ListHead>
                        <ListHead hideBelow="lg" className="w-[6rem]">
                          Created
                        </ListHead>
                        <ListHead hideBelow="xl" className="w-[7.5rem]">
                          Created by
                        </ListHead>
                        <ListHead className="w-[3.75rem]">
                          <span className="sr-only">Actions</span>
                        </ListHead>
                      </ListHeader>
                      <Body>
                        {rows.map((key, i) => {
                          const revoked = key ? key.revoked_at !== null : false
                          const ticked = key !== undefined && selection.isTicked(key)
                          return (
                            <BoneScope key={key?.id ?? i} id={`row-${i}`} unit>
                              <RowEl
                                muted={revoked}
                                className={cn(ticked && selectedRowClass)}
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
                                    {key &&
                                      (!revoked && key.can_revoke
                                        ? selection.rowBox(key, `Select ${key.name}`)
                                        : lockedBox(
                                            `Select ${key.name}`,
                                            revoked
                                              ? "Revoked keys cannot be selected"
                                              : "You cannot revoke this key",
                                          ))}
                                  </Bone>
                                </td>
                                <ListCell className="pl-0 font-medium">
                                  <Bone
                                    id="name"
                                    width={NAME_WIDTHS[i % NAME_WIDTHS.length]}
                                    lineHeight={20}
                                  >
                                    {key && (
                                      <span className="flex min-w-0 items-center gap-2">
                                        <span className="truncate" title={key.name}>
                                          {key.name}
                                        </span>
                                        {revoked && (
                                          <Badge tone="neutral" className="shrink-0">
                                            Revoked
                                          </Badge>
                                        )}
                                      </span>
                                    )}
                                  </Bone>
                                </ListCell>
                                <ListCell>
                                  {/*
                                   * ⚠ THE PREFIX ONLY, AND IT IS ALL WE HAVE. Nothing stores
                                   * the key, so this is not a redaction of something we could
                                   * show - it is the whole of what exists. The trailing dots
                                   * say so without claiming there is a reveal.
                                   */}
                                  <Bone id="prefix" width={80} lineHeight={16}>
                                    {key && (
                                      <span className="font-mono text-xs text-muted-foreground">
                                        {key.prefix}…
                                      </span>
                                    )}
                                  </Bone>
                                </ListCell>
                                <ListCell>
                                  <Bone
                                    id="mode"
                                    shape="box"
                                    width={48}
                                    height={20}
                                    radius={9999}
                                    inline
                                  >
                                    {key && (
                                      <Badge
                                        tone={key.mode === "live" ? "info" : "neutral"}
                                      >
                                        {key.mode}
                                      </Badge>
                                    )}
                                  </Bone>
                                </ListCell>
                                <ListCell hideBelow="sm">
                                  <Bone id="sends-from" width={84} lineHeight={16}>
                                    {key &&
                                      (key.domains.length > 0 ? (
                                        <span
                                          className="block truncate font-mono text-xs"
                                          title={key.domains.join(", ")}
                                        >
                                          {key.domains.join(", ")}
                                        </span>
                                      ) : (
                                        // ⚠ "Any domain" RATHER THAN A DASH. A dash reads as
                                        // "not set", and the most important thing this column can
                                        // say is that a key is unrestricted.
                                        <span className="block truncate text-xs text-muted-foreground">
                                          Any domain
                                        </span>
                                      ))}
                                  </Bone>
                                </ListCell>
                                <ListCell hideBelow="md" className="text-xs text-muted-foreground">
                                  <Bone id="last-used" width={68} lineHeight={16}>
                                    {key &&
                                      (key.last_used_at ? (
                                        <Time iso={key.last_used_at} />
                                      ) : (
                                        // ⚠ "Never" IS AN ANSWER AND A DASH IS NOT. A key that
                                        // has never been used is the single most common thing
                                        // worth deleting.
                                        <span className="text-muted-foreground">
                                          Never
                                        </span>
                                      ))}
                                  </Bone>
                                </ListCell>
                                <ListCell hideBelow="lg" className="text-xs text-muted-foreground">
                                  <Bone id="created" width={68} lineHeight={16}>
                                    {key && <Time iso={key.created_at} />}
                                  </Bone>
                                </ListCell>
                                <ListCell hideBelow="xl" className="text-xs text-muted-foreground">
                                  <Bone id="created-by" width={80} lineHeight={16}>
                                    {key && (
                                      <span className="block truncate" title={createdBy(key)}>
                                        {createdBy(key)}
                                      </span>
                                    )}
                                  </Bone>
                                </ListCell>
                                <ListCell className="py-1.5 text-right">
                                  {/* Hover-only, so a skeleton draws nothing here. */}
                                  {key && !revoked && (
                                    <RowMenu label={key.name}>
                                      <DropdownMenuItem
                                        onSelect={() =>
                                          void navigator.clipboard
                                            .writeText(key.id)
                                            .then(
                                              () => toastDone("Key ID copied"),
                                              () => toastError("Could not copy the ID"),
                                            )
                                        }
                                      >
                                        <Copy />
                                        Copy ID
                                      </DropdownMenuItem>
                                      {(key.can_edit ||
                                        key.can_rotate ||
                                        key.can_revoke) && <DropdownMenuSeparator />}
                                      {key.can_edit && (
                                        <DropdownMenuItem
                                          onSelect={() => setScoping(key)}
                                        >
                                          <Globe />
                                          Change scope
                                        </DropdownMenuItem>
                                      )}
                                      {key.can_rotate && (
                                        <DropdownMenuItem
                                          onSelect={() => setRotating(key)}
                                        >
                                          <RefreshCw />
                                          Rotate
                                        </DropdownMenuItem>
                                      )}
                                      {key.can_revoke && (
                                        <>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem
                                            variant="destructive"
                                            onSelect={() => setRevoking(key)}
                                          >
                                            <Trash2 />
                                            Revoke
                                          </DropdownMenuItem>
                                        </>
                                      )}
                                    </RowMenu>
                                  )}
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
            </div>
          )}

          <BulkBar
            count={picked.length}
            onClear={selection.clear}
            label="Selected keys"
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  .writeText(picked.map((k) => k.name).join("\n"))
                  .then(
                    () =>
                      toastDone(
                        picked.length === 1 ? "Key name copied" : "Key names copied",
                      ),
                    () => toastError("Could not copy the names"),
                  )
              }
            >
              <Copy />
              Copy names
            </Button>
            <Button variant="danger" size="sm" onClick={() => setBulkRevoking(picked)}>
              <Trash2 />
              Revoke
            </Button>
          </BulkBar>

          <ApiKeyScopeDialog
            apiKey={scoping}
            domains={domains}
            onOpenChange={(open) => !open && setScoping(null)}
          />

          <ConfirmDialog
            open={bulkRevoking !== null}
            onOpenChange={(open) => !open && setBulkRevoking(null)}
            title={
              (bulkRevoking?.length ?? 0) === 1
                ? `Revoke ${bulkRevoking?.[0]?.name ?? "this key"}?`
                : `Revoke ${bulkRevoking?.length ?? 0} keys?`
            }
            description="Anything using them stops sending immediately - not at the end of a cache window. This cannot be undone; create new keys instead."
            confirmLabel={
              (bulkRevoking?.length ?? 0) === 1 ? "Revoke key" : "Revoke keys"
            }
            doneLabel="Revoked"
            confirmWord={confirmWordFor(
              (bulkRevoking ?? []).map((k) => k.name),
              "Revoke",
            )}
            onConfirm={async () => {
              if (!bulkRevoking) return false
              // One recent sign-in covers the batch; see the single revoke below.
              if (!(await stepUp())) return false
              const { done, failed } = await forEachPicked(bulkRevoking, (k) =>
                revokeApiKey(k.id),
              )
              if (failed > 0)
                toastError(
                  done === 0
                    ? "Could not revoke the keys"
                    : `Revoked ${done}, ${failed} could not be revoked`,
                )
              selection.clear()
              return done > 0
            }}
          />

          <ConfirmDialog
            open={revoking !== null}
            onOpenChange={(open) => !open && setRevoking(null)}
            title={`Revoke ${shownRevoking?.name ?? "this key"}?`}
            description="Anything using it stops sending immediately - not at the end of a cache window. This cannot be undone; create a new key instead."
            confirmLabel="Revoke key"
            doneLabel="Revoked"
            confirmWord={confirmWordFor([revoking?.name], "Revoke")}
            onConfirm={async () => {
              if (!revoking) return false
              /*
               * ⚠ PROVED BEFORE THE KEY DIES, NOT AFTER. Revoking the key
               * production sends with is an outage nobody can undo from this
               * dialog, and a session cookie is a credential that outlives the
               * person sitting at the machine. The API refuses this on its own -
               * see `requireFreshAuth` - so this is the prompt, not the guard.
               */
              if (!(await stepUp())) return false

              const result = await revokeApiKey(revoking.id)
              if (!result.ok) {
                toastError("Could not revoke the key", {
                  description: result.error,
                })
                return false
              }
              return true
            }}
          />

          <ConfirmDialog
            open={rotating !== null}
            onOpenChange={(open) => {
              if (open) return
              setRotating(null)
              if (issued.current) {
                setRotated(issued.current)
                issued.current = null
              }
            }}
            title={`Rotate ${shownRotating?.name ?? "this key"}?`}
            description="A new key is issued and the old one stops working immediately. Deploy the new value before rotating, or sending will fail in the gap."
            confirmLabel="Rotate key"
            doneLabel="Rotated"
            // ⚠ ROTATING KILLS THE OLD KEY IMMEDIATELY, so it asks like revoke does.
            confirmWord={rotating?.name}
            destructive={false}
            onConfirm={async () => {
              if (!rotating) return false
              // The API asks for a recent sign-in before it rotates; this is the prompt.
              if (!(await stepUp())) return false
              const result = await rotateApiKey(rotating.id)
              if (!result.ok) {
                toastError("Could not rotate the key", {
                  description: result.error,
                })
                return false
              }
              issued.current = result.data
              return true
            }}
          />

          {/*
           * ⚠ THE ROTATED SECRET GETS THE SAME ONE-CHANCE TREATMENT AS A NEW ONE,
           * for the same reason: nothing stores it. Rotation is the more dangerous
           * of the two, because the old key is already dead - losing this value
           * means an outage, not just an unused row.
           */}
          <Dialog
            open={rotated !== null}
            onOpenChange={(open) => {
              if (!open) return
            }}
          >
            <DialogContent
              onEscapeKeyDown={(event) => event.preventDefault()}
              onPointerDownOutside={(event) => event.preventDefault()}
              title="Your new key"
              description="The previous key stopped working the moment this one was issued. Copy it now - it will not be shown again."
              style={{ width: "min(calc(100vw - 2rem), 512px)" }}
            >
              {shownRotated && (
                <CopyField value={shownRotated.secret} className="py-2" />
              )}
              <DialogFooter>
                <Button onClick={() => setRotated(null)}>I have copied it</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </PageBody>
        {data && data.error === undefined && (
          <RememberShape
            def={apiKeysShape}
            shape={shape}
            skip={query !== "" || mode !== "" || state !== ""}
          />
        )}
      </Page>
    </BoneScope>
  )
}
