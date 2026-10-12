"use client"

import * as React from "react"

async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied, or a context that lied about having the API. Fall
    // through - the legacy path below often still works.
  }

  /*
   * ⚠ THE FALLBACK HAS TO SELECT A TEXTAREA, WHICH TAKES FOCUS, SO FOCUS IS PUT
   * BACK - caret and selection included - before the browser can paint. Without
   * this, copying the word in a type-to-confirm dialog left the field unfocused
   * (or blinking out and back) whenever the async clipboard was refused.
   */
  const had = document.activeElement
  const range =
    had instanceof HTMLInputElement || had instanceof HTMLTextAreaElement
      ? ([had.selectionStart, had.selectionEnd] as const)
      : null

  try {
    const area = document.createElement("textarea")
    area.value = text
    // ⚠ OFF-SCREEN RATHER THAN `display: none`. A hidden element cannot hold a
    // selection, so `execCommand("copy")` copies nothing and reports success.
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.top = "-9999px"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  } finally {
    if (had instanceof HTMLElement && had !== document.body) {
      had.focus({ preventScroll: true })
      if (range && range[0] !== null && range[1] !== null) {
        ;(had as HTMLInputElement).setSelectionRange(range[0], range[1])
      }
    }
  }
}

/**
 * ⚠ THE CONFIRMATION IS THE ICON, NOT A TOAST. This button appears up to a
 * dozen times on a domain detail page; a toast per press would stack a column
 * of identical notifications over the records the person is copying. The
 * swap to a tick for two seconds is local, silent, and impossible to miss
 * because the cursor is already on it.
 */
export function useCopy(timeout = 2000) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // ⚠ CLEARED ON UNMOUNT. Copying and immediately navigating away otherwise
  // sets state on a component that is gone - React 19 no longer warns about it,
  // which makes it quieter rather than less wrong.
  React.useEffect(() => () => clearTimeout(timer.current), [])

  const copy = React.useCallback(
    async (value: string) => {
      const ok = await writeToClipboard(value)
      if (!ok) return false
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), timeout)
      return true
    },
    [timeout],
  )

  return { copied, copy }
}
