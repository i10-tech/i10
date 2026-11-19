"use client"

import { formatExact, formatRelative, formatUtc } from "@/lib/format"
import { useMounted } from "@/lib/react"

/**
 * A timestamp, rendered without a hydration mismatch.
 *
 * ⚠ THIS EXISTS BECAUSE EVERY TIMESTAMP IN A CLIENT COMPONENT IS A HYDRATION
 * HAZARD, AND THE CONSOLE HAS EIGHT TABLES FULL OF THEM. A client component is
 * rendered TWICE: once on the server to produce the initial HTML, and again in
 * the browser to hydrate it. Both of these formatters give a different answer
 * in those two places -
 *
 *   • `formatRelative` reads `Date.now()`. A row rendered at 59 seconds old on
 *     the server and hydrated at 61 seconds old says "just now" in the HTML and
 *     "a minute ago" in the browser.
 *   • `formatExact` formats in the runtime's TIME ZONE. The server container is
 *     UTC and the reader is not, so every single row disagrees - by hours.
 *
 * React responds by logging a hydration error and discarding the server HTML
 * for that subtree. It is not cosmetic: on a fifty-row log it throws away the
 * whole table and re-renders it on the client.
 *
 * ⚠ THE FIX IS TO RENDER SOMETHING TIMEZONE-INDEPENDENT UNTIL MOUNTED. Before
 * hydration both passes produce the same UTC string, so the markup matches;
 * after mount the browser swaps in the local or relative form. `useMounted` is
 * `useSyncExternalStore` with a `false` server snapshot, so this is one
 * subscription rather than a state update - see lib/react.ts.
 *
 * ⚠ AND `title` HAS TO FOLLOW THE SAME RULE. An attribute is part of the DOM
 * React compares; a `title` that differs mismatches exactly as text does, and
 * that was the easiest half of this bug to miss.
 */
const utcExact = (iso: string) => formatUtc(iso, "exact")

/**
 * `formatExact` for a time inside a sentence ("Renews Dec 4, 2026, 09:00:00"),
 * where a <Time> cannot go: the same rule, the UTC form until mounted.
 *
 * ⚠ THE ONLY WAY TO FORMAT AN EXACT TIME OUTSIDE THIS FILE (2026-11-18). A raw
 * `formatExact` in markup is a hydration mismatch by hours in production, where
 * the server is UTC; test/relative-time-guard.test.ts fails on one.
 */
export function useExactTime(): (iso: string) => string {
  return useMounted() ? formatExact : utcExact
}

export function Time({
  iso,
  mode = "relative",
  className,
}: {
  iso: string
  /** `relative` - "2 hours ago". `exact` - "17 Sep 2026, 14:32:05". */
  mode?: "relative" | "exact"
  className?: string
}) {
  const mounted = useMounted()

  /*
   * ⚠ RELATIVE TIME IS RELATIVE IN BOTH PASSES (2026-11-09). "26 minutes ago"
   * does not depend on a time zone, and server and browser clocks agree to the
   * minute almost always; the UTC fallback ("Nov 9") flipped to the relative
   * form on every reload. The rare minute boundary between the passes is let
   * through by `suppressHydrationWarning` and corrected by the mount render.
   * Exact time still waits for mount: it does depend on the zone.
   */
  const text =
    mode === "relative"
      ? formatRelative(iso)
      : mounted
        ? formatExact(iso)
        : formatUtc(iso, mode)

  return (
    <time
      // ⚠ THE MACHINE-READABLE VALUE IS ALWAYS THE RAW ISO STRING, WHICHEVER
      // FORM IS ON SCREEN. It is what a screen reader and anything scraping the
      // page should get, and it is identical in both passes.
      dateTime={iso}
      suppressHydrationWarning
      title={mounted ? formatExact(iso) : formatUtc(iso, "exact")}
      className={className}
    >
      {text}
    </time>
  )
}
