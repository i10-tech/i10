"use client"

import * as React from "react"
import { cn } from "cn"
import { Copy, Globe, KeyRound, RefreshCw, SearchX, Trash2 } from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { DropdownMenuItem, DropdownMenuSeparator } from "@repo/ui/components/i10/menu"
import { MotionBody, MotionRow } from "@/components/list/motion"
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
} from "@/components/list/toolbar"
import { ApiKeyScopeDialog, type ScopeDomain } from "@/components/api-key-scope"
import { useStepUp } from "@/lib/step-up"
import { ConfirmDialog, confirmWordFor } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { revokeApiKey, rotateApiKey } from "@/lib/actions"
import { useRetained } from "@/lib/react"
import type { ApiKeyRow, CreatedApiKey } from "@/lib/types"
import { Time } from "@/components/time"
import { toastDone, toastError } from "@/lib/toast"
import { RowMenu } from "@/components/list/row-menu"

/**
 * The key list.
 *
 * ⚠ REVOKED KEYS STAY IN THE TABLE, GREYED, RATHER THAN DISAPPEARING. During an
 * incident the question is "did we revoke that one, and when" - and a key that
 * vanishes on revocation makes that unanswerable from the console. It is also
 * the difference between "I revoked it" and "I think I revoked it".
 *
 * ⚠ AND `last_used_at` IS THE MOST USEFUL COLUMN HERE. A key nothing has
 * touched in months is either dead weight or a credential somebody forgot they
 * issued; both are worth deleting, and neither is visible without this column.
 */
export function ApiKeysTable({
  keys,
  domains = [],
}: {
  keys: ApiKeyRow[]
  domains?: ScopeDomain[]
}) {
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
  const shown = keys.filter(
    (k) =>
      (!q ||
        k.name.toLowerCase().includes(q) ||
        k.prefix.toLowerCase().includes(q) ||
        k.domains.some((d) => d.includes(q))) &&
      (!mode || k.mode === mode) &&
      (!state || (state === "revoked") === (k.revoked_at !== null)),
  )
  const clear = () => {
    setQuery("")
    setMode("")
    setState("")
  }

  // Only a live key can be acted on; a revoked one stays listed, untickable.
  const selection = useListSelection(
    shown.filter((k) => k.revoked_at === null),
    (k) => k.id,
  )
  const { picked } = selection
  const [bulkRevoking, setBulkRevoking] = React.useState<ApiKeyRow[] | null>(null)

  if (keys.length === 0) {
    return (
      <EmptyState
        icon={<KeyRound />}
        title="No API keys yet"
        description="Create one and paste it into your server's environment. It is shown once - we store only a hash."
      />
    )
  }

  return (
    <>
      <ListToolbar>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search keys"
          label="Search API keys"
        />
        <FilterSelect
          value={mode}
          onValueChange={setMode}
          label="Mode"
          allLabel="All modes"
          options={[
            { value: "live", label: "Live" },
            { value: "test", label: "Test" },
          ]}
        />
        <FilterSelect
          value={state}
          onValueChange={setState}
          label="State"
          allLabel="Active and revoked"
          className="w-48"
          options={[
            { value: "active", label: "Active" },
            { value: "revoked", label: "Revoked" },
          ]}
        />
      </ListToolbar>
      <ResultsLine
        count={shown.length}
        query={query}
        filtered={mode !== "" || state !== ""}
        noun={["key", "keys"]}
        onClear={clear}
      />

      <div className="pt-4">
        {shown.length === 0 ? (
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
              <th className="w-10 py-2.5 pl-4">
                {selection.headerBox("Select all live keys")}
              </th>
              <ListHead className="pl-0">Name</ListHead>
              <ListHead className="w-[10rem]">Key</ListHead>
              <ListHead className="w-[6rem]">Mode</ListHead>
              {/*
               * ⚠ IT EARNS A COLUMN RATHER THAN A BADGE BESIDE THE NAME. "Which
               * of my keys can reach production" is the question somebody asks
               * this table during an incident, and a value that is only visible
               * on the row you happen to be reading does not answer it.
               */}
              <ListHead className="hidden w-[12rem] sm:table-cell">Sends from</ListHead>
              <ListHead className="hidden w-[10rem] md:table-cell">Last used</ListHead>
              <ListHead className="hidden w-[10rem] lg:table-cell">Created</ListHead>
              <ListHead className="w-12">
                <span className="sr-only">Actions</span>
              </ListHead>
            </ListHeader>
            <MotionBody>
              {shown.map((key) => {
                const revoked = key.revoked_at !== null
                return (
                  <MotionRow
                    key={key.id}
                    className={cn(
                      revoked && "opacity-50",
                      selection.isTicked(key) && selectedRowClass,
                    )}
                  >
                    <td className="w-10 py-3 pl-4">
                      {!revoked && selection.rowBox(key, `Select ${key.name}`)}
                    </td>
                    <ListCell className="pl-0 font-medium">
                      {key.name}
                      {revoked && (
                        <Badge tone="neutral" className="ml-2">
                          Revoked
                        </Badge>
                      )}
                    </ListCell>
                    <ListCell>
                      {/*
                       * ⚠ THE PREFIX ONLY, AND IT IS ALL WE HAVE. Nothing stores
                       * the key, so this is not a redaction of something we could
                       * show - it is the whole of what exists. The trailing dots
                       * say so without claiming there is a reveal.
                       */}
                      <span className="font-mono text-xs text-muted-foreground">
                        {key.prefix}…
                      </span>
                    </ListCell>
                    <ListCell>
                      <Badge tone={key.mode === "live" ? "info" : "neutral"}>
                        {key.mode}
                      </Badge>
                    </ListCell>
                    <ListCell className="hidden sm:table-cell">
                      {key.domains.length > 0 ? (
                        <span className="font-mono text-xs">
                          {key.domains.join(", ")}
                        </span>
                      ) : (
                        // ⚠ "Any domain" RATHER THAN A DASH. A dash reads as
                        // "not set", and the most important thing this column can
                        // say is that a key is unrestricted.
                        <span className="text-xs text-muted-foreground">
                          Any domain
                        </span>
                      )}
                    </ListCell>
                    <ListCell className="hidden text-xs text-muted-foreground md:table-cell">
                      {key.last_used_at ? (
                        <Time iso={key.last_used_at} />
                      ) : (
                        // ⚠ "Never" IS AN ANSWER AND A DASH IS NOT. A key that
                        // has never been used is the single most common thing
                        // worth deleting.
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </ListCell>
                    <ListCell className="hidden text-xs text-muted-foreground lg:table-cell">
                      <Time iso={key.created_at} />
                    </ListCell>
                    <ListCell className="py-1.5 text-right">
                      {!revoked && (
                        <RowMenu label={key.name}>
                          <DropdownMenuItem
                            onSelect={() =>
                              void navigator.clipboard.writeText(key.id).then(
                                () => toastDone("Key ID copied"),
                                () => toastError("Could not copy the ID"),
                              )
                            }
                          >
                            <Copy />
                            Copy ID
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setScoping(key)}>
                            <Globe />
                            Change scope
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setRotating(key)}>
                            <RefreshCw />
                            Rotate
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setRevoking(key)}
                          >
                            <Trash2 />
                            Revoke
                          </DropdownMenuItem>
                        </RowMenu>
                      )}
                    </ListCell>
                  </MotionRow>
                )
              })}
            </MotionBody>
          </ListTable>
        )}
      </div>

      <ApiKeyScopeDialog
        apiKey={scoping}
        domains={domains}
        onOpenChange={(open) => !open && setScoping(null)}
      />

      <BulkBar count={picked.length} onClear={selection.clear} label="Selected keys">
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

      <ConfirmDialog
        open={bulkRevoking !== null}
        onOpenChange={(open) => !open && setBulkRevoking(null)}
        title={
          (bulkRevoking?.length ?? 0) === 1
            ? `Revoke ${bulkRevoking?.[0]?.name ?? "this key"}?`
            : `Revoke ${bulkRevoking?.length ?? 0} keys?`
        }
        description="Anything using them stops sending immediately - not at the end of a cache window. This cannot be undone; create new keys instead."
        confirmLabel={(bulkRevoking?.length ?? 0) === 1 ? "Revoke key" : "Revoke keys"}
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
            toastError("Could not revoke the key", { description: result.error })
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
          const result = await rotateApiKey(rotating.id)
          if (!result.ok) {
            toastError("Could not rotate the key", { description: result.error })
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
          {shownRotated && <CopyField value={shownRotated.secret} className="py-2" />}
          <DialogFooter>
            <Button onClick={() => setRotated(null)}>I have copied it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
