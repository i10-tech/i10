/*
 * Liveness and readiness for the auth pod.
 *
 * ⚠ IT TOUCHES NOTHING. A probe that rendered a sign-in page would depend on
 * Clerk being reachable, so a Clerk outage would fail liveness and restart
 * every replica — turning somebody else's outage into ours, at the exact moment
 * customers are trying to sign in. See apps/console/app/healthz/route.ts, which
 * exists for the same reason.
 */
export function GET() {
  return Response.json({ ok: true })
}
