import { workspaceKey } from "@/lib/workspace-key"

/**
 * Pages Next keeps for a revisit, and which of them it probably still has.
 *
 * ⚠ NEXT HOLDS THE DATA, NOT US. A page that exports `unstable_dynamicStaleTime`
 * is kept in Next's client cache that long after it arrived, so clicking back to
 * it renders what was there without asking the server. Next empties that whole
 * cache after any server action that revalidates or refreshes, and on
 * `router.refresh()` (a workspace switch does one), so a revisit never shows data
 * from before a mutation or from another workspace. All this file keeps is a
 * guess at which pages Next still has, so the click does not draw a skeleton
 * over a page about to appear whole (lib/pending-navigation.ts). A wrong guess
 * costs a skeleton drawn a little late, never stale data.
 *
 * ⚠ A REVISIT IS THEN CHECKED (components/revisit-check.tsx): the server is asked
 * for the page's fingerprint and the page is refreshed in place only when it
 * changed. Refreshing every revisit would be simpler and would cost every other
 * kept page, because a refresh empties Next's cache.
 */

/** The `unstable_dynamicStaleTime` of every page that renders `<Revisit>`. */
export const REVISIT_SECONDS = 300

// Next counts its window from when the page arrived, a moment after this is
// noted: guessing a few seconds short keeps the guess inside it.
const WARM_MS = (REVISIT_SECONDS - 10) * 1000

interface Visit {
  /** Which server render was shown. */
  rendered: string
  /** Which mounted page showed it, to tell a re-run effect from a remount. */
  mount: object
  workspace: string
  at: number
}

const visits = new Map<string, Visit>()

/**
 * - `fresh`: the server just drew this page for this visit.
 * - `cached`: a render shown before, on a new mount: Next drew it from its cache.
 * - `redrawn`: the page on screen was drawn again in place (an action, a refresh),
 *   which is when Next empties its cache.
 * - `again`: nothing new (an effect re-run).
 */
export type VisitKind = "fresh" | "cached" | "redrawn" | "again"

/** Notes that `url` shows the server render `rendered`, in the mounted page `mount`. */
export function noteVisit(url: string, rendered: string, mount: object): VisitKind {
  const before = visits.get(url)
  const workspace = workspaceKey()
  const same = before?.workspace === workspace && before.rendered === rendered
  if (same && before.mount === mount) return "again"
  if (same) {
    before.mount = mount
    return "cached"
  }
  visits.set(url, { rendered, mount, workspace, at: Date.now() })
  return before?.mount === mount ? "redrawn" : "fresh"
}

/** Whether `url` still shows the server render `rendered`. */
export function isShowing(url: string, rendered: string): boolean {
  return visits.get(url)?.rendered === rendered
}

/** Next emptied its cache, so only `url`, on screen, is still kept. */
export function forgetOtherVisits(url: string) {
  for (const key of visits.keys()) if (key !== url) visits.delete(key)
}

/** Whether a click to `url` will most likely be drawn from Next's cache. */
export function isWarm(url: string): boolean {
  const visit = visits.get(url)
  return (
    visit !== undefined &&
    visit.workspace === workspaceKey() &&
    Date.now() - visit.at < WARM_MS
  )
}

/**
 * A short fingerprint of a page's data, to tell whether it changed.
 *
 * ⚠ ONLY FOR THAT. A collision costs one revisit that keeps its old data until
 * the next one; cyrb53 makes that about a one-in-2^53 event.
 */
export function versionOf(data: unknown): string {
  const text = JSON.stringify(data) ?? ""
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
