"use client"

import * as React from "react"
import { ARRIVAL_PARAM, setArrival, type Arrival } from "@/lib/arrival"

/**
 * Moves an arrival fact out of the address bar and into its cookie.
 *
 * ⚠ FOR THE ONE CASE WE CANNOT STOP AT THE SOURCE: a redirect back from a
 * third party. Polar appends `?checkout_id=` to its success URL, so a page
 * reached that way is born with it. This keeps the fact — so a reload still
 * shows the payment banner — and removes the parameter, without a navigation.
 */
export function ArrivalQuery({ names }: { names: Arrival[] }) {
  React.useEffect(() => {
    const url = new URL(window.location.href)
    let moved = false
    for (const name of names) {
      const param = ARRIVAL_PARAM[name]
      const value = url.searchParams.get(param)
      if (value === null) continue
      setArrival(name, value, url.pathname)
      url.searchParams.delete(param)
      moved = true
    }
    if (moved) window.history.replaceState(null, "", url.toString())
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, [])

  return null
}
