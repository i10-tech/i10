/*
 * The footer's status pill, backed by the real API.
 *
 * ⚠ A SERVER ROUTE AND NOT A BROWSER FETCH. api.i10.tech/healthz sends no
 * CORS headers - it is a probe endpoint, not a public API - so the page asks
 * this route and this route asks the API. The answer is cached for 30s so a
 * burst of visitors turns into one probe.
 *
 * Three answers and only three: operational, degraded (the API answered but
 * not with ok), unreachable. The pill never claims more than it measured.
 */
export const revalidate = 30

export async function GET() {
  const started = Date.now()
  try {
    const res = await fetch("https://api.i10.tech/healthz", {
      next: { revalidate: 30 },
      signal: AbortSignal.timeout(3000),
    })
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null
    const status = res.ok && body?.ok ? "operational" : "degraded"
    return Response.json({ status, latencyMs: Date.now() - started, checkedAt: new Date().toISOString() })
  } catch {
    return Response.json({ status: "unreachable", checkedAt: new Date().toISOString() })
  }
}
