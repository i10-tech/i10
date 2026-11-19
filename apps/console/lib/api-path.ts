/**
 * Which API paths the console may call with a person's session (the choke point
 * in `api()`, lib/api.ts).
 *
 * ⚠ TWO PREFIXES, AND THE SECOND IS NARROW ON PURPOSE. `/console/*` is the
 * console's own surface. `/mailboxes` and `/mailboxes/*` are the API's
 * session-authenticated mailbox routes that are not under `/console` because
 * people reach them outside the console too: a member creating their own
 * mailbox, and a mailbox's export and import (apps/api/src/routes/mailbox-migration.ts).
 * Each of those checks who is asking itself, so the session token going there
 * grants nothing the person did not already have.
 *
 * ⚠ THIS WAS ONLY `/console/` UNTIL U7, AND `createOwnMailbox` (`POST /mailboxes`)
 * WAS REFUSED BY IT. It passed review because preview mode answers from fixtures
 * before the guard runs; against a real API it failed with `invalid_path`. The
 * rule is a function of its own so a test can hold both halves: the routes the
 * console needs are reachable, and a crafted id still cannot leave them.
 *
 * ⚠ THE TRAVERSAL RULES APPLY TO BOTH, UNCHANGED. A server action is a public
 * POST endpoint whose arguments are the caller's, and `new URL()` normalises `..`
 * away, so `/mailboxes/../x` would otherwise leave as `/x`.
 */
const REACHABLE = [/^\/console\//, /^\/mailboxes(?:\/|$)/]

export function isReachablePath(path: string): boolean {
  if (
    path.includes("..") ||
    path.includes("//") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\")
  ) {
    return false
  }
  return REACHABLE.some((prefix) => prefix.test(path))
}
