"use client"

import * as React from "react"
import {
  Copy,
  Globe,
  KeyRound,
  MoreHorizontal,
  RefreshCw,
  SearchX,
  Trash2,
} from "lucide-react"
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
import { MotionBody, MotionRow } from "@/components/list/motion"
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
} from "@/components/list/toolbar"
import { ApiKeyScopeDialog, type ScopeDomain } from "@/components/api-key-scope"
import { useStepUp } from "@/lib/step-up"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { revokeApiKey, rotateApiKey } from "@/lib/actions"
import { useRetained } from "@/lib/react"
import type { ApiKeyRow, CreatedApiKey } from "@/lib/types"
import { Time } from "@/components/time"

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
              <Button size="sm" variant="outline" onClick={clear}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <ListTable>
            <ListHeader>
              <ListHead>Name</ListHead>
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
                    className={revoked ? "opacity-50" : undefined}
                  >
                    <ListCell className="font-medium">
                      {key.name}
                      {revoked && (
                        <Badge variant="outline" className="ml-2">
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
                      <Badge variant={key.mode === "live" ? "secondary" : "outline"}>
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
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className={rowMenuClass}
                              aria-label={`Actions for ${key.name}`}
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                              onSelect={() =>
                                void navigator.clipboard.writeText(key.id).then(
                                  () => toast.success("Key ID copied"),
                                  () => toast.error("Could not copy the ID"),
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
                          </DropdownMenuContent>
                        </DropdownMenu>
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

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${shownRevoking?.name ?? "this key"}?`}
        description="Anything using it stops sending immediately - not at the end of a cache window. This cannot be undone; create a new key instead."
        confirmLabel="Revoke key"
        doneLabel="Revoked"
        confirmWord={revoking?.name}
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
            toast.error("Could not revoke the key", { description: result.error })
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
            toast.error("Could not rotate the key", { description: result.error })
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
          className="sm:max-w-lg"
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Your new key</DialogTitle>
            <DialogDescription>
              The previous key stopped working the moment this one was issued. Copy it
              now - it will not be shown again.
            </DialogDescription>
          </DialogHeader>
          {shownRotated && <CopyField value={shownRotated.secret} className="py-2" />}
          <DialogFooter>
            <Button onClick={() => setRotated(null)}>I have copied it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
