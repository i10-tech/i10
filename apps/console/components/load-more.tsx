"use client"

import { useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"

/**
 * The next page of a cursor-paginated list.
 *
 * ⚠ IT REPLACES THE PAGE RATHER THAN APPENDING TO IT, AND THAT IS A DELIBERATE
 * TRADE. Infinite scroll needs the rows in client state, which means fetching
 * them in the browser, which means the whole table stops being server-rendered
 * — a spinner where there is currently HTML, and a list that cannot be linked
 * to. Advancing the cursor in the URL keeps the page shareable and the render
 * on the server; the cost is that "back" is a browser action rather than a
 * button, which browsers are extremely good at.
 *
 * ⚠ AND `useTransition` IS WHAT STOPS IT FEELING BROKEN. Without it the button
 * does nothing visible for however long the query takes, so people press it
 * twice. The pending state disables it and shows the spinner.
 */
export function LoadMore({ cursor }: { cursor: string | null }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, start] = useTransition()

  if (!cursor) return null

  function next() {
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
      <Button variant="outline" size="sm" onClick={next} disabled={pending}>
        {pending && <Spinner />}
        Load more
      </Button>
    </div>
  )
}
