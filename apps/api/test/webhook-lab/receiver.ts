/**
 * A webhook receiver that records everything and misbehaves on request, the
 * same one the Svix lab used (2026-10-05). The path picks the behaviour:
 *
 *   /ok/<tag>                200
 *   /fail/<tag>              500
 *   /hang/<tag>              never answers
 *   /flaky/<tag>?n=2         500 for the first n deliveries of each webhook-id, then 200
 *   /ratelimit/<tag>?s=3     429 with Retry-After: s
 *   /redirect/<tag>          302 to /ok/<tag>-redirected
 *   /jitter/<tag>            200 after a random 0-300ms
 *   /failk/<tag>?k=0         500 when the event's `data.k` equals k, else 200
 */

export interface Received {
  at: number
  mode: string
  tag: string
  /** Which delivery of this webhook-id to this path this is, from 1. */
  n: number
  headers: Record<string, string>
  body: string
  /** `data` from the envelope, for scenarios that tag their events. */
  data: Record<string, unknown>
}

export interface Receiver {
  port: number
  log: Received[]
  of: (tag: string) => Received[]
  /** How many requests are being held open by /hang right now. */
  hanging: () => number
  stop: () => void
}

export function startReceiver(): Receiver {
  const log: Received[] = []
  const seen = new Map<string, number>()
  let hanging = 0

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const [, mode = "", tag = ""] = url.pathname.split("/")
      const body = await req.text()
      const id = req.headers.get("webhook-id") ?? ""
      const n = (seen.get(id + url.pathname) ?? 0) + 1
      seen.set(id + url.pathname, n)
      let data: Record<string, unknown> = {}
      try {
        data = (JSON.parse(body) as { data?: Record<string, unknown> }).data ?? {}
      } catch {
        // Not JSON; recorded as is.
      }
      log.push({
        at: Date.now(),
        mode,
        tag,
        n,
        headers: Object.fromEntries(req.headers),
        body,
        data,
      })

      switch (mode) {
        case "ok":
          return new Response("ok")
        case "fail":
          return new Response("boom", { status: 500 })
        case "hang":
          hanging++
          return new Promise<Response>((resolve) => {
            req.signal.addEventListener("abort", () => {
              hanging--
              resolve(new Response(null))
            })
          })
        case "flaky":
          return n <= Number(url.searchParams.get("n") ?? 2)
            ? new Response("not yet", { status: 500 })
            : new Response("ok")
        case "ratelimit":
          return new Response("slow down", {
            status: 429,
            headers: { "retry-after": url.searchParams.get("s") ?? "3" },
          })
        case "redirect":
          return Response.redirect(`http://${url.host}/ok/${tag}-redirected`, 302)
        case "jitter":
          await Bun.sleep(Math.random() * 300)
          return new Response("ok")
        case "failk":
          return String(data.k) === url.searchParams.get("k")
            ? new Response("not this one", { status: 500 })
            : new Response("ok")
        default:
          return new Response("?", { status: 404 })
      }
    },
  })

  return {
    port: server.port!,
    log,
    of: (tag) => log.filter((e) => e.tag === tag),
    hanging: () => hanging,
    stop: () => server.stop(true),
  }
}
