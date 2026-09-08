/*
 * Liveness and readiness for the console pod.
 *
 * ⚠ IT EXISTS BECAUSE THE PROBES USED TO HIT `/`, AND `/` NOW NEEDS A SESSION.
 * That mattered in a way a redirect hides: a signed-out probe gets a 307 to the
 * Account Portal, and kubelet counts 3xx as healthy — so the probe passes for a
 * reason that has nothing to do with the pod working. The failure it stops
 * being able to see is the one that matters: if Clerk is unreachable and
 * `auth.protect()` raises instead of redirecting, `/` answers 5xx, liveness
 * fails, and every console pod restarts in a loop during an outage that was
 * never ours. A probe must never depend on a third party.
 *
 * Deliberately not `dynamic = "force-dynamic"`: there is nothing to render and
 * nothing to read, so a static answer is the honest one.
 */
export function GET() {
  return Response.json({ ok: true })
}
