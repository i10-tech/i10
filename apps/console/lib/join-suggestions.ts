"use client"

import * as React from "react"
import {
  joinWorkspace,
  myJoinSuggestions,
  requestToJoin,
  type JoinSuggestion,
} from "@/lib/actions"

/**
 * The workspaces suggested to the signed-in person (2026-10-13) - ours, not
 * Clerk's `userSuggestions`, which needs a Clerk plan we do not have. The API
 * works them out from the person's verified addresses; see
 * apps/api/src/console/team-domains.ts.
 *
 * ⚠ ONE EVENT KEEPS EVERY COPY IN STEP. The suggestion cards and the
 * workspace switcher each hold the list; asking to join from one tells the
 * other, so a workspace never reads "Request to join" in the switcher after it
 * says "Requested" on the page.
 */
const CHANGED = "i10:join-suggestions-changed"

export function useJoinSuggestions() {
  const [list, setList] = React.useState<JoinSuggestion[] | null>(null)

  const load = React.useCallback(() => {
    void myJoinSuggestions().then((result) =>
      setList(result.ok ? result.data.data : []),
    )
  }, [])

  React.useEffect(() => {
    load()
    window.addEventListener(CHANGED, load)
    return () => window.removeEventListener(CHANGED, load)
  }, [load])

  const ask = React.useCallback(async (tenantId: string) => {
    const result = await requestToJoin(tenantId)
    if (result.ok) window.dispatchEvent(new Event(CHANGED))
    return result
  }, [])

  /** Joins at once where the workspace's rule is auto-join (#326). */
  const join = React.useCallback(async (tenantId: string) => {
    const result = await joinWorkspace(tenantId)
    if (result.ok) window.dispatchEvent(new Event(CHANGED))
    return result
  }, [])

  return { list, ask, join }
}
