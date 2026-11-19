import * as React from "react"

/** Longer than this and the un-inlined email is shown while assets load. */
export const SLOW_MS = 1200

/**
 * Inlines `html` and publishes what to show.
 *
 * ⚠ THE INLINED EMAIL IS PUBLISHED AS SOON AS IT IS READY - usually at once,
 * because the thumbnails already memoised its assets. Only if it is still
 * pending after `slowMs` is the plain HTML published first, and the inlined
 * one replaces it when it lands. A failed inlining leaves the plain HTML.
 *
 * ⚠ THE RETURNED CANCEL MAKES A RESULT STALE: nothing is published after it,
 * so a slow inlining of old HTML never overwrites a newer email.
 */
export function startInlining(
  html: string,
  inline: (html: string) => Promise<string>,
  publish: (html: string) => void,
  slowMs: number = SLOW_MS,
): () => void {
  let live = true
  const slow = setTimeout(() => {
    if (live) publish(html)
  }, slowMs)
  inline(html)
    .catch(() => html)
    .then((out) => {
      if (!live) return
      clearTimeout(slow)
      publish(out)
    })
  return () => {
    live = false
    clearTimeout(slow)
  }
}

/**
 * The HTML to put in the frame: null until there is something to show, then
 * the inlined email. While a newer email is being inlined the previous one
 * stays, so the frame does not blank between edits.
 */
export function useInlinedEmail(
  html: string,
  inline: (html: string) => Promise<string>,
): string | null {
  const [shown, setShown] = React.useState<string | null>(null)
  React.useEffect(() => startInlining(html, inline, setShown), [html, inline])
  return shown
}
