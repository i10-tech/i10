"use client"

/**
 * Switching theme, in one pass the browser can afford.
 *
 * ⚠ ONE FULL RESTYLE, NOT THREE. Changing the theme swaps the colour tokens on
 * `:root`, and WebKit restyles every element when any custom property there
 * changes (measured 2026-11-18 on /emails, 2,253 elements: 107ms in WebKit, 21
 * in Chrome). next-themes' `disableTransitionOnChange` adds a stylesheet,
 * forces a restyle and removes it a millisecond later: two more full restyles,
 * 178ms in WebKit, and the second lands in the middle of a view transition's
 * crossfade, which is why Safari showed a frozen old page, a frozen new page
 * and no fade. Here transitions are stilled by a class added in the same pass
 * as the theme, and only released once the switch has finished.
 *
 * ⚠ THE DOM IS CHANGED HERE, SYNCHRONOUSLY. next-themes applies a theme in a
 * React effect, so inside `startViewTransition` nothing guaranteed the page had
 * changed before the new picture was taken. `setTheme` still runs, to store the
 * choice and update React; its effect then writes the same values again.
 */

export type ThemeChoice = "light" | "dark" | "system"

const STILL = "theme-still"
const THEMES = ["light", "dark"] as const
let release: number | undefined

const resolved = (choice: ThemeChoice): "light" | "dark" =>
  choice === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : choice

function apply(choice: ThemeChoice) {
  const root = document.documentElement
  const theme = resolved(choice)
  root.classList.remove(...THEMES)
  root.classList.add(theme)
  root.setAttribute("data-theme", theme)
  root.style.colorScheme = theme
}

/** Releases the stilled transitions after the frame that shows the new theme. */
function settle() {
  window.clearTimeout(release)
  release = window.setTimeout(
    () => requestAnimationFrame(() => document.documentElement.classList.remove(STILL)),
    50,
  )
}

export function switchTheme(
  choice: ThemeChoice,
  setTheme: (theme: string) => void,
  how: { crossfade?: boolean } = {},
) {
  const change = () => {
    window.clearTimeout(release)
    document.documentElement.classList.add(STILL)
    apply(choice)
    setTheme(choice)
  }
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  if (!how.crossfade || still || !document.startViewTransition) {
    change()
    settle()
    return
  }
  const done = () => settle()
  document.startViewTransition(change).finished.then(done, done)
}
