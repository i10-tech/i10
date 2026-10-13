"use client"

import * as React from "react"
import Link from "next/link"
import { Alert } from "@repo/ui/components/alert/alert"

const KEY = "i10-capacity-dismissed"
const subscribeNothing = () => () => {}
const readDismissed = () => {
  try {
    return window.localStorage.getItem(KEY)
  } catch {
    // Storage unavailable: keep showing it.
    return null
  }
}

/**
 * The banner itself, with its dismissal remembered in this browser for this
 * crossing only. See CapacityBanner.
 *
 * ⚠ A CONVENIENCE, NOT STATE. Storage that throws or comes back empty shows
 * the banner again, which is the safe side to fail on.
 */
export function CapacityAlert({
  level,
  members,
  limit,
  canUpgrade,
  crossing,
}: {
  level: 80 | 100
  members: number
  limit: number
  canUpgrade: boolean
  crossing: string
}) {
  // The server renders it open; the browser then reads what it remembers.
  const remembered = React.useSyncExternalStore(
    subscribeNothing,
    readDismissed,
    () => null,
  )
  const [dismissed, setDismissed] = React.useState(false)
  const open = !dismissed && remembered !== crossing

  const full = level === 100
  return (
    <Alert
      tone={full ? "danger" : "warning"}
      title={
        full
          ? "This workspace has reached its member limit"
          : "This workspace is close to its member limit"
      }
      open={open}
      onDismiss={() => {
        setDismissed(true)
        try {
          window.localStorage.setItem(KEY, crossing)
        } catch {
          // Nothing to remember it in; it shows again next time.
        }
      }}
    >
      <span className="block not-first:mt-1.5">
        {members} of {limit} members.{" "}
        {full
          ? "Nobody new can join until a spot frees up."
          : "Pending invitations take spots too."}{" "}
        <Link href="/settings/team" className="underline underline-offset-4">
          Manage the team
        </Link>
        {canUpgrade ? (
          <>
            {" or "}
            <Link href="/settings/billing" className="underline underline-offset-4">
              see plans
            </Link>
          </>
        ) : null}
        .
      </span>
    </Alert>
  )
}
