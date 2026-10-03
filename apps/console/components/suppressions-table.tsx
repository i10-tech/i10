"use client"

import * as React from "react"
import Link from "next/link"
import { SearchX, ShieldCheck, Undo2 } from "lucide-react"
import { AnimatePresence, motion, type Transition } from "motion/react"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  ListCell,
  ListHead,
  ListHeader,
  ListTable,
  rowClass,
} from "@/components/list/table"
import {
  ListToolbar,
  UrlClearFilters,
  UrlFilterSelect,
  UrlSearchField,
} from "@/components/list/toolbar"
import { ListRegion, UrlList, useUrlList } from "@/components/list/url-state"
import { EmptyState } from "@/components/empty-state"
import { LoadMore } from "@/components/load-more"
import { removeSuppression } from "@/lib/actions"
import type { SuppressionRow } from "@/lib/types"
import { useResetWhen, useRetained } from "@/lib/react"
import { Time } from "@/components/time"
import { toastError } from "@/lib/toast"

/**
 * The suppression list.
 *
 * ⚠ REMOVING AN ENTRY IS CONFIRMED, AND THE CONFIRMATION SAYS WHAT IT DOES NOT
 * DO. Removing an address does not guarantee delivery - if it bounces again it
 * is suppressed again automatically, and every attempt in between counts
 * against the account's reputation with that receiving network. People remove
 * entries expecting the mail to start arriving; the dialog is the one chance to
 * say that is not how it works.
 *
 * ⚠ THE ROW LEAVES THE MOMENT IT IS CONFIRMED, NOT WHEN THE SERVER AGREES.
 * Removing a suppression is a write, a revalidation and a re-render of the whole
 * page - on a slow connection that is a second or more during which the dialog
 * has closed and the row somebody just removed is still sitting there. They
 * press it again. `useOptimistic` takes the row out immediately and puts it back
 * if the call fails, which is the only version where the interface and the
 * person agree about what just happened.
 *
 * ⚠ IT IS PLAIN STATE AND `useResetWhen`, NOT `useOptimistic`, AND THAT IS A
 * CORRECTION RATHER THAN A PREFERENCE. `useOptimistic` was tried first and the
 * row never left: its value only exists while React considers an Action
 * pending, and an `await` inside a hand-rolled `startTransition` did not keep it
 * pending here - so the update was discarded before it could paint, with no
 * error anywhere to say so. Measured, not assumed: the row was still in the DOM
 * at 0, 10, 25, 50, 100, 200, 400, 800 and 1500ms after the confirmation.
 *
 * A list of hidden addresses is the same idea with none of the ambiguity - it is
 * visible in the render, it is cleared by exactly one rule, and the failure path
 * is a line of code rather than a framework behaviour.
 *
 * ⚠ AND IT IS CLEARED WHEN THE SERVER SENDS A NEW LIST, WHICH IS WHAT KEEPS IT
 * FROM BECOMING A LIE. Holding "hidden" forever would suppress the row even if
 * the address bounced again and the server legitimately sent it back. Tying the
 * reset to `rows` identity means the optimistic view survives exactly as long as
 * the data it is guessing about - see lib/react.ts for why that is a render-phase
 * comparison rather than an effect.
 *
 * ⚠ AND THE REASON COLUMN IS NOT DECORATION. `hard_bounce` means the address
 * does not exist and never will; `complaint` means a real person pressed "this
 * is spam", and removing that one is a decision with legal weight in several
 * jurisdictions. They are not interchangeable and the UI does not treat them as
 * such.
 */
const REASON_COPY: Record<string, { label: string; detail: string }> = {
  hard_bounce: {
    label: "Hard bounce",
    detail: "The receiving server said this address does not exist.",
  },
  complaint: {
    label: "Complaint",
    detail: "The recipient marked a message as spam.",
  },
  manual: { label: "Added by hand", detail: "Somebody on your team added this." },
  unsubscribe: {
    label: "Unsubscribed",
    detail: "The recipient used an unsubscribe link.",
  },
}

/**
 * How the rows below close the gap. Short, and shorter than the sidebar's - a
 * row leaving a table is not a shared element travelling across the screen, and
 * anything over about 200ms makes removing several in a row feel like queueing
 * behind an animation.
 */
const ROW_LAYOUT: Transition = {
  type: "spring",
  stiffness: 550,
  damping: 45,
  mass: 0.8,
}

/**
 * ⚠ A TWEEN, NOT A SPRING, AND THE FIRST VERSION OF THIS WAS A REAL BUG RATHER
 * THAN A STYLE SLIP. The spring tokens in @repo/ui/styles/tokens.css say in so
 * many words that springs are for transforms and sizes and NEVER for opacity -
 * an overshoot on opacity means going past fully transparent and coming back,
 * which is both invisible and slow to settle. `AnimatePresence` keeps an exiting
 * element mounted until its exit animation FINISHES, so a spring that takes a
 * long tail to reach zero is a row that stays on screen long after it was
 * removed. Caught by watching a row that never left: with the animation frame
 * loop paused, the spring never settled and the row simply never unmounted.
 */
const ROW_EXIT: Transition = { duration: 0.12, ease: "easeIn" }

export function SuppressionsTable({
  rows,
  nextCursor,
}: {
  rows: SuppressionRow[]
  nextCursor: string | null
}) {
  return (
    <UrlList className="space-y-4">
      <ListToolbar>
        <UrlSearchField
          placeholder="Search addresses"
          label="Search suppressed addresses"
        />
        <UrlFilterSelect
          param="reason"
          label="Reason"
          allLabel="All reasons"
          options={Object.entries(REASON_COPY).map(([value, r]) => ({
            value,
            label: r.label,
          }))}
        />
        <UrlClearFilters params={["search", "reason"]} />
      </ListToolbar>
      <ListRegion>
        <SuppressionRows rows={rows} nextCursor={nextCursor} />
      </ListRegion>
    </UrlList>
  )
}

function SuppressionRows({
  rows,
  nextCursor,
}: {
  rows: SuppressionRow[]
  nextCursor: string | null
}) {
  const { params, commit } = useUrlList()
  const filtered = Boolean(params.get("search") || params.get("reason"))
  const [removing, setRemoving] = React.useState<SuppressionRow | null>(null)

  /*
   * ⚠ KEYED ON THE ADDRESS, WHICH IS THIS TABLE'S REAL PRIMARY KEY. It is
   * already what `key={row.address}` uses below, and a suppression list cannot
   * hold the same address twice - so filtering by it is exact rather than a
   * guess at identity.
   */
  const shownRemoving = useRetained(removing)
  const [hidden, setHidden] = React.useState<string[]>([])
  useResetWhen(rows, () => setHidden([]))

  const visibleRows =
    hidden.length === 0 ? rows : rows.filter((row) => !hidden.includes(row.address))

  return (
    <div className="space-y-4">
      {visibleRows.length === 0 ? (
        <EmptyState
          icon={filtered ? <SearchX /> : <ShieldCheck />}
          title={filtered ? "No matching addresses" : "Nothing suppressed"}
          description={
            filtered
              ? "Try a different search, or clear the filters."
              : "Addresses that hard-bounce or complain land here automatically. An empty list is a good sign."
          }
          secondary={
            filtered ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  commit((p) => ["search", "reason"].forEach((f) => p.delete(f)))
                }
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ListTable>
            <ListHeader>
              <ListHead>Address</ListHead>
              <ListHead className="w-[12rem]">Reason</ListHead>
              <ListHead className="hidden w-[9rem] md:table-cell">Message</ListHead>
              <ListHead className="w-[9rem] text-right">Added</ListHead>
              <ListHead className="w-12">
                <span className="sr-only">Actions</span>
              </ListHead>
            </ListHeader>
            <tbody className="divide-y">
              {/*
               * ⚠ `initial={false}` SO A PAGE OF ROWS DOES NOT FADE ITSELF IN.
               * The only animation wanted here is the one on the way OUT -
               * rows arriving from the server should already be there.
               */}
              <AnimatePresence initial={false}>
                {visibleRows.map((row) => {
                  const reason = REASON_COPY[row.reason] ?? {
                    label: row.reason,
                    detail: "",
                  }
                  return (
                    <motion.tr
                      key={row.address}
                      /*
                       * ⚠ `layout` ON THE ROW IS WHAT CLOSES THE GAP SMOOTHLY.
                       * Without it the rows below snap up the instant this one
                       * unmounts, which is a hard jump in the middle of an
                       * animation whose whole purpose is to remove one.
                       */
                      layout
                      exit={{ opacity: 0, transition: ROW_EXIT }}
                      transition={ROW_LAYOUT}
                      className={rowClass}
                    >
                      <ListCell className="max-w-0">
                        <span className="block truncate font-mono text-xs select-all">
                          {row.address}
                        </span>
                      </ListCell>
                      <ListCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge variant="outline" className="cursor-default">
                              {reason.label}
                            </Badge>
                          </TooltipTrigger>
                          {reason.detail && (
                            <TooltipContent>{reason.detail}</TooltipContent>
                          )}
                        </Tooltip>
                      </ListCell>
                      <ListCell className="hidden md:table-cell">
                        {row.message_id ? (
                          <Link
                            href={`/emails/${row.message_id}`}
                            className="font-mono text-xs text-muted-foreground underline-offset-4 hover:underline"
                          >
                            View
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </ListCell>
                      <ListCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
                        <Time iso={row.created_at} />
                      </ListCell>
                      <ListCell className="py-1.5 text-right">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-7"
                              aria-label={`Remove ${row.address} from the suppression list`}
                              onClick={() => setRemoving(row)}
                            >
                              <Undo2 />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Remove from the list</TooltipContent>
                        </Tooltip>
                      </ListCell>
                    </motion.tr>
                  )
                })}
              </AnimatePresence>
            </tbody>
          </ListTable>

          <LoadMore cursor={nextCursor} />
        </>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this suppression?"
        description={
          // Retained: the dialog closes at once, and the text must not flip to
          // the other sentence while it fades out. See `useRetained`.
          shownRemoving?.reason === "complaint"
            ? "This recipient marked a message as spam. Sending to them again risks your reputation and, in some jurisdictions, breaks the law. If they bounce or complain again they are suppressed again automatically."
            : "We will start sending to this address again. If it bounces again it is suppressed again automatically - removing it does not guarantee delivery."
        }
        confirmLabel="Remove"
        confirmWord={removing?.address}
        destructive={false}
        onConfirm={async () => {
          if (!removing) return false
          const { address, reason } = removing

          /*
           * ⚠ THE DIALOG CLOSES FIRST AND THE CALL IS NOT AWAITED HERE. The
           * whole point is that the confirmation is the last thing the person
           * has to wait for; holding the dialog open until the server answers
           * would put the round trip back exactly where it was removed from.
           * Failure is reported by a toast, and the row reappears on its own
           * when the optimistic value is discarded.
           */
          setRemoving(null)
          setHidden((current) => [...current, address])

          void (async () => {
            const result = await removeSuppression(address, {
              complaint: reason === "complaint",
            })

            if (!result.ok) {
              // ⚠ PUT BACK BY ADDRESS, NOT BY CLEARING THE WHOLE LIST. Somebody
              // can confirm two removals in the time one round trip takes, and
              // clearing would resurrect the other one too.
              setHidden((current) => current.filter((a) => a !== address))
              toastError("Could not remove it", { description: result.error })
              return
            }

            // ⚠ NO TOAST AND NO REFRESH. The row already left on its own exit
            // animation, which is the confirmation; `removeSuppression`
            // revalidates this page, so the new list arrives in the action's
            // own response and `useResetWhen` above drops the guess in that
            // same render.
          })()

          return true
        }}
      />
    </div>
  )
}
