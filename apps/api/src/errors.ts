/**
 * One readable sentence for an unknown throw.
 *
 * ⚠ EVERY CALLER OF THIS WRITES THE RESULT SOMEWHERE A PERSON READS IT — a
 * `last_error` column a customer sees in their dashboard, a log line somebody
 * greps at three in the morning. `String(err)` on an Error gives
 * "Error: fetch failed", which names neither the endpoint nor the cause; the
 * name and message together at least say which failure it was.
 *
 * ⚠ AND `TimeoutError` IS SPELLED OUT, BECAUSE IT IS THE COMMON ONE AND IT
 * READS AS A BUG. `AbortSignal.timeout` rejects with that name, so an endpoint
 * that simply never answered — the single most frequent webhook and provider
 * failure there is — would otherwise be recorded as an exception that looks
 * like ours rather than a timeout that is theirs.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return "timed out waiting for a response"
    return `${err.name}: ${err.message}`
  }
  return String(err)
}

/**
 * The same, plus every `cause` underneath it.
 *
 * ⚠ SEPARATE FROM `describeError` BECAUSE THE TWO HAVE DIFFERENT AUDIENCES.
 * That one writes a sentence into `last_error`, which a CUSTOMER reads in their
 * dashboard: it must stay short and must never expose the shape of our
 * internals. This one is for a log line WE read, where the opposite is true —
 * the internals are the entire point.
 *
 * ⚠ AND IT EXISTS BECAUSE A WRAPPED ERROR HIDES ITS ONLY USEFUL PART. Drizzle
 * reports every database failure as `Error: Failed query: <the SQL>` and hangs
 * the driver's real error on `cause`. Logging the wrapper prints the SQL we
 * already wrote and not one word about why it failed — which is how
 * `could not read usage for a feature` appeared sixty-nine times in production
 * with no way to tell a missing grant from a missing table from a timeout.
 *
 * ⚠ IT CARRIES `code`, WHICH IS THE FIELD THAT ACTUALLY IDENTIFIES THE FAULT.
 * `42501` is a missing grant and `42P01` is a missing relation; their messages
 * differ by a few words and their fixes have nothing in common.
 */
export function describeErrorChain(error: unknown, depth = 4): string {
  const parts: string[] = []

  let current: unknown = error
  for (let i = 0; i < depth && current !== null && current !== undefined; i += 1) {
    const e = current as { code?: string; cause?: unknown }
    const described = describeError(current)
    parts.push(e.code ? `${described} [${e.code}]` : described)

    // ⚠ STOPS WHEN THE CHAIN STOPS, AND ALSO WHEN IT LOOPS. A `cause` pointing
    // back at its own error is rare and entirely possible, and an unbounded
    // walk of one is a hang on the logging path.
    if (e.cause === undefined || e.cause === null || e.cause === current) break
    current = e.cause
  }

  return parts.join(" ← ")
}
