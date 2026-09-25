import { cookies } from "next/headers"
import type { Arrival } from "@/lib/arrival"

/**
 * An arrival fact for this render — see ./arrival.ts.
 *
 * ⚠ THE QUERY STILL WINS WHEN IT IS THERE, BECAUSE SOMETHING WE DO NOT OWN
 * PUT IT THERE. Polar appends `?checkout_id=` to its success URL on the
 * full-page checkout; `ArrivalQuery` moves it into the cookie and out of the
 * address bar on the first paint, and every render after that reads the cookie.
 */
export async function readArrival(
  name: Arrival,
  fromQuery?: string | null,
): Promise<string | null> {
  if (fromQuery) return fromQuery
  const raw = (await cookies()).get(name)?.value
  return raw ? decodeURIComponent(raw) : null
}
