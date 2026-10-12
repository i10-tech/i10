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
