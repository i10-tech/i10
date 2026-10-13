"use client"

import * as React from "react"

/**
 * The workspace's name as the shell shows it, kept in step with a rename.
 *
 * ⚠ THE SHELL BAR'S NAME COMES FROM THE SERVER ONCE, IN THE LAYOUT, and a
 * layout does not render again on navigation - so after a rename the rail
 * (Clerk's own store, reloaded by the form) showed the new name and the
 * breadcrumb kept the old one until a full reload. The rename form announces
 * the saved name here; anything showing it listens. No refresh, no refetch.
 */
const EVENT = "i10:workspace-renamed"

/** Called once a rename has been saved. */
export function announceWorkspaceName(name: string) {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: name }))
}

/** The name to show: the server's, then whatever a rename announced since. */
export function useWorkspaceName(fromServer: string): string {
  const [announced, setAnnounced] = React.useState<string | null>(null)
  React.useEffect(() => {
    const listen = (event: Event) => setAnnounced((event as CustomEvent<string>).detail)
    window.addEventListener(EVENT, listen)
    return () => window.removeEventListener(EVENT, listen)
  }, [])
  // A server render that has caught up wins again, so a rename made in
  // another tab is not undone by this one's stale announcement.
  const [seen, setSeen] = React.useState(fromServer)
  if (fromServer !== seen) {
    setSeen(fromServer)
    setAnnounced(null)
  }
  return announced ?? fromServer
}

const CHANGED = "i10:workspaces-changed"

/**
 * Anything about the signed-in person's workspaces changed: a name, a logo,
 * one deleted or created (2026-10-13). The two pickers (the rail's switcher
 * and the Settings header's) hold Clerk's cached membership list, which only
 * refetches when asked - so after a rename they kept the old name and after
 * a delete they kept the workspace. They ask when they hear this.
 */
export function announceWorkspacesChanged() {
  window.dispatchEvent(new Event(CHANGED))
}

export function useWorkspacesChanged(refresh: () => void) {
  const latest = React.useRef(refresh)
  React.useEffect(() => {
    latest.current = refresh
  })
  React.useEffect(() => {
    const listen = () => latest.current()
    window.addEventListener(CHANGED, listen)
    window.addEventListener(EVENT, listen)
    return () => {
      window.removeEventListener(CHANGED, listen)
      window.removeEventListener(EVENT, listen)
    }
  }, [])
}
