"use client"

import { ThemeProvider } from "next-themes"

/**
 * The light/dark provider, shared by every app in the workspace.
 *
 * ⚠ WITHOUT THIS AN APP IS PERMANENTLY LIGHT, AND NOTHING ANYWHERE SAYS SO.
 * The token sheet defines its dark palette under a `.dark` CLASS, and a class
 * does not apply itself — an app that renders no provider gets the `:root`
 * light palette on a machine set to dark, with no error to explain it. That is
 * exactly what apps/console shipped with. `attribute="class"` is what puts
 * `.dark` on <html>, which is the selector the tokens are already written
 * against.
 *
 * ⚠ IT LIVES IN THE PACKAGE RATHER THAN IN EACH APP BECAUSE THE DEFAULT IS A
 * PRODUCT DECISION, NOT AN APP ONE. Two copies is two places for "we are dark
 * by default" to be written differently, which is how the console came to be
 * white while auth was dark — someone signing in on a dark page and landing on
 * a white one has been shown a seam that does not exist in the product.
 *
 * ⚠ AND `next-themes` IS ALREADY HERE REGARDLESS. shadcn's Sonner calls
 * `useTheme()` to match the toast to the page; with no provider that call
 * returns nothing and the toasts sit on the wrong ground.
 *
 * ⚠ `disableTransitionOnChange` STOPS THE SWEEP. Every colour token is on a
 * transition somewhere; without this, switching theme animates the entire page
 * through an intermediate mud for a few hundred milliseconds.
 */
export function Theme({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      /**
       * ⚠ DARK IS THE DEFAULT, NOT THE SYSTEM SETTING. `enableSystem` stays on
       * so "system" remains a choice a person can make later, but with nothing
       * stored this lands on dark regardless of what the machine prefers —
       * which is the decision, not a fallback.
       */
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  )
}
