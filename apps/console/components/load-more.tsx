"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { useRoutePathname, useRouteSearchParams } from "@/lib/target-route"
import { Button } from "@repo/ui/components/button/button"

/**
 * The next page of a cursor-paginated list.
 *
 * ⚠ IT REPLACES THE PAGE RATHER THAN APPENDING TO IT, AND THAT IS A DELIBERATE
 * TRADE. Infinite scroll needs the rows in client state, which means fetching
 * them in the browser, which means the whole table stops being server-rendered
 * - a spinner where there is currently HTML, and a list that cannot be linked
 * to. Advancing the cursor in the URL keeps the page shareable and the render
 * on the server; the cost is that "back" is a browser action rather than a
 * button, which browsers are extremely good at.
 *
 * ⚠ AND `useTransition` IS WHAT STOPS IT FEELING BROKEN. Without it the button
 * does nothing visible for however long the query takes, so people press it
 * twice. The pending state disables it and shows the spinner.
 *
 * ⚠ `hasMore` IS THE SHAPE'S, FOR A SKELETON. Loading there is no cursor to
 * read, but the page will have a button, and the skeleton draws it inert.
 */
export function LoadMore({
  cursor,
  hasMore = Boolean(cursor),
}: {
  cursor: string | null | undefined
  hasMore?: boolean
}) {
  const router = useRouter()
  const pathname = useRoutePathname()
  const searchParams = useRouteSearchParams()
  const [pending, start] = useTransition()

  if (!hasMore) return null

  function next() {
    if (!cursor) return
    const params = new URLSearchParams(searchParams.toString())
    params.set("cursor", cursor!)
    start(() => {
      // ⚠ `scroll: true` HERE, UNLIKE THE FILTERS. This genuinely is a new page
      // of results; leaving the viewport at the bottom would show the end of a
      // list the person has not seen the start of.
      router.push(`${pathname}?${params.toString()}`)
    })
  }

  return (
    <div className="flex justify-center">
      <Button
        loading={pending}
        variant="secondary"
        size="sm"
        onClick={next}
        disabled={pending || !cursor}
      >
        Load more
      </Button>
    </div>
  )
}
