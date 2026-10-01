"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { cn } from "cn"

/**
 * Filters that live in the URL, for the lists the server pages.
 *
 * ⚠ ONE TRANSITION FOR THE WHOLE LIST, SO THE ROWS SAY THEY ARE CHANGING. A
 * filter is a server round trip; without a pending state the old rows sit
 * there unchanged until the new ones replace them in a single frame, which
 * reads as the click doing nothing. `ListRegion` fades the rows while the
 * transition runs, and every control inside `UrlList` shares it.
 *
 * ⚠ THE CURSOR IS ALWAYS DROPPED ON A FILTER CHANGE. It points into the
 * previous result set, so carrying it would start the new list part-way down.
 */
interface UrlListState {
  params: URLSearchParams
  pending: boolean
  commit: (mutate: (params: URLSearchParams) => void) => void
}

const UrlListContext = React.createContext<UrlListState | null>(null)

function useOwnUrlState(): UrlListState {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, start] = React.useTransition()
  const commit = React.useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString())
      mutate(params)
      params.delete("cursor")
      const query = params.toString()
      start(() =>
        router.push(query ? `${pathname}?${query}` : pathname, { scroll: false }),
      )
    },
    [pathname, router, searchParams],
  )
  return React.useMemo(
    () => ({ params: new URLSearchParams(searchParams.toString()), pending, commit }),
    [searchParams, pending, commit],
  )
}

export function UrlList({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const state = useOwnUrlState()
  return (
    <UrlListContext.Provider value={state}>
      <div className={className}>{children}</div>
    </UrlListContext.Provider>
  )
}

/** The list's URL state; works outside `UrlList` too, with its own transition. */
export function useUrlList(): UrlListState {
  const shared = React.useContext(UrlListContext)
  const own = useOwnUrlState()
  return shared ?? own
}

/** One parameter: its value, and a setter that clears it when given "". */
export function useUrlParam(name: string): [string, (value: string) => void] {
  const { params, commit } = useUrlList()
  const value = params.get(name) ?? ""
  const set = React.useCallback(
    (next: string) =>
      commit((p) => {
        if (next) p.set(name, next)
        else p.delete(name)
      }),
    [commit, name],
  )
  return [value, set]
}

/**
 * A search box's text: local while typing, committed to the URL 350ms after
 * the last keystroke, and following the URL when it changes elsewhere.
 */
export function useUrlSearch(name = "search"): [string, (value: string) => void] {
  const [committed, commitSearch] = useUrlParam(name)
  const [text, setText] = React.useState(committed)
  // ⚠ FOLLOWS THE URL ONLY WHEN THE URL SAYS SOMETHING ELSE. The commit is
  // trimmed, so "acme " committing "acme" must not eat the space being typed.
  // Adjusted during render - see lib/react.ts.
  const [seen, setSeen] = React.useState(committed)
  if (committed !== seen) {
    setSeen(committed)
    if (committed !== text.trim()) setText(committed)
  }
  React.useEffect(() => {
    if (text.trim() === committed) return
    const timer = setTimeout(() => commitSearch(text.trim()), 350)
    return () => clearTimeout(timer)
  }, [text, committed, commitSearch])
  return [text, setText]
}

/** The rows of a URL list, faded while a filter change is on its way. */
export function ListRegion({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  const { pending } = useUrlList()
  return (
    <div
      aria-busy={pending || undefined}
      className={cn(
        "transition-opacity duration-200 ease-out",
        pending && "pointer-events-none opacity-55",
        className,
      )}
    >
      {children}
    </div>
  )
}
