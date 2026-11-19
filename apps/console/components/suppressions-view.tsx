"use client"

import * as React from "react"
import Link from "next/link"
import { Download, SearchX, ShieldCheck, Undo2 } from "lucide-react"
import { AnimatePresence, motion, type Transition } from "motion/react"
import { Bone, BoneRegion, BoneScope } from "@repo/ui/components/bone/bone"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
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
import { Tooltip } from "@repo/ui/components/tooltip/tooltip"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { AddSuppressionButton } from "@/components/add-suppression"
import { ConfirmDialog, confirmWordFor } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { ApiButton } from "@/components/list/api-button"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import {
  ListCell,
  ListHead,
  ListHeader,
  ListTable,
  rowClass,
} from "@/components/list/table"
import {
  ListToolbar,
  ListToolbarEnd,
  UrlFilterSelect,
  UrlListResults,
  UrlListSearch,
} from "@/components/list/toolbar"
import { ListRegion, UrlList, useUrlList } from "@/components/list/url-state"
import { LoadMore } from "@/components/load-more"
import { PanelError } from "@/components/panel-error"
import { Time } from "@/components/time"
import { removeSuppression } from "@/lib/actions"
import { PAGE_COPY } from "@/lib/page-copy"
import { useResetWhen, useRetained, NONE } from "@/lib/react"
import {
  suppressionsShape,
  type SuppressionsData,
  type SuppressionsShape,
} from "@/lib/shapes/suppressions"
import { SNIPPETS } from "@/lib/snippets"
import { toastError } from "@/lib/toast"
import type { SuppressionRow } from "@/lib/types"

/** What loading.tsx renders: the view with the shape this workspace last had. */
export function SuppressionsLoading() {
  return <SuppressionsView shape={useRememberedShape(suppressionsShape)} />
}

/**
 * The suppression list.
 *
 * The suppression list, loaded and loading: ONE view, so the skeleton cannot drift
 * from the page (docs/decisions/skeletons.md).
 *
 * ⚠ THIS LIST PROTECTS THE ACCOUNT, NOT THE RECIPIENT, AND THE DISTINCTION
 * MATTERS WHEN SOMEBODY ASKS TO REMOVE AN ENTRY. Continuing to send to an
 * address that hard-bounced is the fastest way to lose a sending reputation -
 * every attempt is counted against the account by the receiving networks. An
 * address here is not being punished; it is being skipped so the rest of the
 * mail keeps arriving.
 *
 * ⚠ AND IT IS SEPARATE FROM A CONTACT'S `unsubscribed` FLAG. Unsubscribing from
 * a newsletter must not stop a password reset, and a hard bounce on a
 * transactional message must not silently remove somebody from a marketing list
 * they can still be reached on. Two questions, two tables, both consulted at
 * send.
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
const ROW_LAYOUT: Transition = motionTokens.spring.responsive

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
const ROW_EXIT: Transition = {
  duration: motionTokens.duration.instant,
  ease: [...motionTokens.ease.exit],
}

const ADDRESS_WIDTHS = ["65%", "50%", "78%", "58%"]

export function SuppressionsView({
  shape,
  data,
}: {
  shape: SuppressionsShape
  data?: SuppressionsData
}) {
  const loading = data === undefined
  return (
    <BoneScope id="suppressions" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          {/*
           * ⚠ WRAPS, UNLIKE MOST HEADERS: two actions beside the title do not fit
           * a 375px screen, and the second one went off the edge.
           */}
          <PageHeaderRow className="flex-wrap gap-y-2">
            {loading ? (
              <PlaceholderTitle text={PAGE_COPY.suppressions.title} className={TITLE} />
            ) : (
              <PageTitle>{PAGE_COPY.suppressions.title}</PageTitle>
            )}
            <PageActions>
              <ApiButton snippet={SNIPPETS.suppressions} />
              {/*
               * ⚠ A PLAIN ANCHOR, NOT A `Link`. The target is a file, and Next's
               * client router would try to render a CSV as a page.
               */}
              <ButtonLink
                href="/suppressions/export"
                download
                variant="secondary"
                size="sm"
                native
              >
                <Download />
                Export CSV
              </ButtonLink>
              <AddSuppressionButton />
            </PageActions>
          </PageHeaderRow>
          <PageDescription>{PAGE_COPY.suppressions.description}</PageDescription>
        </PageHeader>

        <PageBody>
          {data?.error !== undefined ? (
            <PanelError title="Could not load suppressions" message={data.error} />
          ) : (
            <UrlList className="space-y-4">
              <SuppressionsContent shape={shape} data={data} loading={loading} />
            </UrlList>
          )}
        </PageBody>
      </Page>
    </BoneScope>
  )
}

function SuppressionsContent({
  shape,
  data,
  loading,
}: {
  shape: SuppressionsShape
  data?: SuppressionsData
  loading: boolean
}) {
  const { params, commit } = useUrlList()
  const filtered = Boolean(params.get("search") || params.get("reason"))
  const rows = data?.rows ?? NONE
  const hasRows = shape.rows > 0

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

  const displayRows: (SuppressionRow | undefined)[] = loading
    ? Array.from({ length: shape.rows }, () => undefined)
    : visibleRows

  if (!hasRows && !filtered) {
    return (
      <EmptyState
        icon={<ShieldCheck />}
        title="Nothing suppressed"
        description="Addresses that hard-bounce or complain land here automatically. An empty list is a good sign."
      />
    )
  }

  return (
    <>
      <ListToolbar>
        <UrlListSearch
          placeholder="Search addresses"
          label="Search suppressed addresses"
        />
        <UrlListResults params={["search", "reason"]} />
        <ListToolbarEnd>
          <UrlFilterSelect
            param="reason"
            label="Reason"
            allLabel="All reasons"
            options={Object.entries(REASON_COPY).map(([value, r]) => ({
              value,
              label: r.label,
            }))}
          />
        </ListToolbarEnd>
      </ListToolbar>

      <ListRegion>
        <div className="space-y-4">
          <BoneRegion id="list">
            {!loading && visibleRows.length === 0 ? (
              <EmptyState
                icon={<SearchX />}
                title="No matching addresses"
                description="Try a different search, or clear the filters."
                secondary={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      commit((p) => ["search", "reason"].forEach((f) => p.delete(f)))
                    }
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              // F = 336 (Reason 140, Added 120, actions 76), Address keeps 220: min 556.
              // Message 96 -> 652 -> sm (704).
              <ListTable className="[&_table]:min-w-[556px]">
                <ListHeader>
                  <ListHead>Address</ListHead>
                  <ListHead className="w-[8.75rem]">Reason</ListHead>
                  <ListHead hideBelow="sm" className="w-[6rem]">
                    Message
                  </ListHead>
                  <ListHead className="w-[7.5rem] text-right">Added</ListHead>
                  <ListHead className="w-[4.75rem]">
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
                    {displayRows.map((row, i) => {
                      const reason = row
                        ? (REASON_COPY[row.reason] ?? {
                            label: row.reason,
                            detail: "",
                          })
                        : undefined
                      return (
                        <BoneScope key={row?.address ?? i} id={`row-${i}`} unit>
                          <motion.tr
                            /*
                             * ⚠ `layout` ON THE ROW IS WHAT CLOSES THE GAP SMOOTHLY.
                             * Without it the rows below snap up the instant this one
                             * unmounts, which is a hard jump in the middle of an
                             * animation whose whole purpose is to remove one.
                             */
                            layout={row ? true : false}
                            exit={{ opacity: 0, transition: ROW_EXIT }}
                            transition={ROW_LAYOUT}
                            className={rowClass}
                          >
                            <ListCell>
                              <Bone
                                id="address"
                                width={ADDRESS_WIDTHS[i % ADDRESS_WIDTHS.length]}
                                lineHeight={16}
                              >
                                {row && (
                                  <span
                                    className="block truncate font-mono text-xs select-all"
                                    title={row.address}
                                  >
                                    {row.address}
                                  </span>
                                )}
                              </Bone>
                            </ListCell>
                            <ListCell>
                              <Bone
                                id="reason"
                                shape="box"
                                width={96}
                                height={20}
                                radius={9999}
                                inline
                              >
                                {reason &&
                                  (reason.detail ? (
                                    <Tooltip content={reason.detail}>
                                      <Badge tone="neutral" tabIndex={0}>
                                        {reason.label}
                                      </Badge>
                                    </Tooltip>
                                  ) : (
                                    <Badge tone="neutral">{reason.label}</Badge>
                                  ))}
                              </Bone>
                            </ListCell>
                            <ListCell hideBelow="sm">
                              <Bone id="message" width={36} lineHeight={16}>
                                {row &&
                                  (row.message_id ? (
                                    <Link
                                      href={`/emails/${row.message_id}`}
                                      className="font-mono text-xs text-muted-foreground underline-offset-4 hover:underline"
                                    >
                                      View
                                    </Link>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">
                                      -
                                    </span>
                                  ))}
                              </Bone>
                            </ListCell>
                            <ListCell className="text-right text-xs whitespace-nowrap text-muted-foreground">
                              <Bone id="added" width={64} lineHeight={16} align="end">
                                {row && <Time iso={row.created_at} />}
                              </Bone>
                            </ListCell>
                            <ListCell className="py-1.5 text-right">
                              {/* The remove button is skipped by test/skeleton-parity: it acts on a row a skeleton does not have. */}
                              {row && (
                                <Tooltip content="Remove from the list">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    data-skeleton="skip"
                                    aria-label={`Remove ${row.address} from the suppression list`}
                                    onClick={() => setRemoving(row)}
                                  >
                                    <Undo2 />
                                  </Button>
                                </Tooltip>
                              )}
                            </ListCell>
                          </motion.tr>
                        </BoneScope>
                      )
                    })}
                  </AnimatePresence>
                </tbody>
              </ListTable>
            )}
          </BoneRegion>

          <LoadMore cursor={data?.nextCursor} hasMore={shape.hasMore} />
        </div>
      </ListRegion>

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
        confirmWord={confirmWordFor([removing?.address])}
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
      {data && data.error === undefined && (
        <RememberShape
          def={suppressionsShape}
          shape={shape}
          skip={filtered || Boolean(params.get("cursor"))}
        />
      )}
    </>
  )
}
