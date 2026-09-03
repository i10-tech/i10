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
