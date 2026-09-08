"use client"

import { ThemeProvider } from "next-themes"

/**
 * Follows the operating system's light/dark setting.
 *
 * ⚠ WITHOUT THIS THE APP IS PERMANENTLY LIGHT, WHICH IS EXACTLY WHAT SHIPPED.
 * The token sheet defines its dark palette under a `.dark` CLASS, and a class
 * does not apply itself — nothing was reading `prefers-color-scheme` at all, so
 * a machine set to dark got the light palette with no error anywhere to explain
 * it. `attribute="class"` is what puts `.dark` on <html>, which is the selector
 * the tokens are already written against.
 *
 * ⚠ AND `next-themes` IS ALREADY HERE REGARDLESS. shadcn's Sonner calls
 * `useTheme()` to match the toast to the page; with no provider that call
 * returns nothing and the toasts sit on the wrong ground. One provider fixes
 * the page and the toasts together.
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
