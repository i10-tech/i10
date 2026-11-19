"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { readPageVersion } from "@/lib/revisit-actions"
import { forgetOtherVisits, isShowing, noteVisit } from "@/lib/revisits"

/**
 * Notes each render of a kept page, and checks a revisit Next drew from its
 * cache: when the server's data has changed since, the page is refreshed in
 * place, so React updates only what changed. See lib/revisits.ts.
 */
export function RevisitCheck({
  version,
  rendered,
}: {
  version: string
  rendered: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams().toString()
  const url = search ? `${pathname}?${search}` : pathname
  const [mount] = React.useState(() => ({}))

  React.useEffect(() => {
    const kind = noteVisit(url, rendered, mount)
    if (kind === "redrawn") forgetOtherVisits(url)
    if (kind !== "cached") return
    void readPageVersion(url)
      .then((now) => {
        if (now === null || now === version) return
        // Gone elsewhere meanwhile: a refresh would redraw that page instead.
        const here = window.location.pathname + window.location.search
        if (here !== url || !isShowing(url, rendered)) return
        // A refresh empties Next's cache, so no other page is kept after it.
        forgetOtherVisits(url)
        React.startTransition(() => router.refresh())
      })
      .catch(() => {
        // The kept page stays; the next visit checks again.
      })
  }, [url, rendered, version, mount, router])

  return null
}
