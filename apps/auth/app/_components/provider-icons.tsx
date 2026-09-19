/*
 * The marks that appear on the sign-in buttons, inline.
 *
 * ⚠ THREE OF THESE ARE SOMEBODY ELSE'S TRADEMARK AND ONE IS NOT, WHICH IS THE
 * ONLY REASON THEY SHARE A FILE. `PasskeyIcon` is a method rather than a brand,
 * so nothing governs its path data and it is drawn to match Lucide's geometry —
 * see its own note. The three below are governed, and the paragraph after this
 * one is about them.
 *
 * ⚠ INLINE SVG RATHER THAN AN ICON PACKAGE, AND NOT FOR BUNDLE SIZE. These are
 * other companies' trademarks: Google, GitHub and Apple each publish brand
 * guidelines that govern the exact path data, and an icon set that "helpfully"
 * redraws or recolours a mark is a licensing problem rather than a styling
 * choice. Keeping the paths here means changing one is a deliberate edit to a
 * file that says so.
 *
 * ⚠ `currentColor` ON GITHUB AND APPLE, LITERAL COLOUR ON GOOGLE. The first two
 * are permitted as monochrome marks and so follow the button's text colour
 * through light and dark. Google's guidelines do not permit recolouring the G,
 * so its four paths carry Google's own hex values and are the one thing on
 * these pages that ignores the token sheet.
 */

export function GoogleIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" {...props}>
      <path
        d="M23.52 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.54 5.54 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.59-5.17 3.59-8.82Z"
        fill="#4285F4"
      />
      <path
        d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.87-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A12 12 0 0 0 12 24Z"
        fill="#34A853"
      />
      <path
        d="M5.27 14.29a7.21 7.21 0 0 1 0-4.58V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09Z"
        fill="#FBBC05"
      />
      <path
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
        fill="#EA4335"
      />
    </svg>
  )
}

/** The mark login-02 and signup-02 shipped with, kept verbatim. */
export function GitHubIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" {...props}>
      <path
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
        fill="currentColor"
      />
    </svg>
  )
}

export function AppleIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" {...props}>
      <path
        d="M17.05 12.54c-.03-2.6 2.12-3.85 2.22-3.91-1.21-1.77-3.09-2.02-3.76-2.04-1.6-.16-3.12.94-3.93.94-.81 0-2.06-.92-3.39-.9-1.74.03-3.35 1.01-4.25 2.57-1.81 3.14-.46 7.79 1.3 10.34.86 1.25 1.89 2.65 3.24 2.6 1.3-.05 1.79-.84 3.36-.84 1.57 0 2.01.84 3.38.81 1.4-.02 2.28-1.27 3.13-2.53.99-1.45 1.4-2.85 1.42-2.92-.03-.01-2.72-1.04-2.75-4.13M14.6 4.6c.71-.87 1.19-2.07 1.06-3.27-1.03.04-2.27.68-3.01 1.55-.66.76-1.24 1.98-1.09 3.15 1.15.09 2.32-.58 3.04-1.43"
        fill="currentColor"
      />
    </svg>
  )
}

/**
 * A passkey: somebody, and the credential that proves it is them.
 *
 * ⚠ NOT LUCIDE'S `KeyRound`, AND THE DISTINCTION IS WORTH ONE SVG. A plain key
 * is what this product already draws next to API keys; using it here would mean
 * the same glyph stands for "a secret you paste into a header" and "the thing
 * on your phone that replaces your password". The person beside the key is the
 * conventional passkey mark precisely because it says WHOSE credential it is.
 *
 * ⚠ DRAWN TO LUCIDE'S GRID SO IT SITS WITH THE REST. 24×24, unfilled, 2px
 * strokes with round caps and joins, and no `size-*` of its own — `Button`
 * sizes any bare `<svg>` inside it, and a hard-coded size here would be the one
 * icon in the row that ignored it.
 */
export function PasskeyIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {/*
       * ⚠ THE PERSON IS LUCIDE'S `UserRound` AT 0.7 SCALE, NOT A SHAPE INVENTED
       * HERE. Head at r=3.5 over a semicircular shoulder arc of r=5.5 — the same
       * proportion between the two that every other person-glyph in the set
       * uses. A first attempt drew the shoulders as a quarter-arc with a tick on
       * the end, which at size renders as a crescent floating under an
       * oversized head rather than as a figure.
       */}
      <circle cx="8" cy="7" r="3.5" />
      <path d="M13.5 19.5a5.5 5.5 0 0 0-11 0" />
      {/*
       * ⚠ THE BOW IS SMALLER THAN THE HEAD AND SITS LOWER, which is what stops
       * the two circles reading as a pair of eyes. The stem ends level with the
       * shoulders so the glyph has one baseline rather than two.
       */}
      <circle cx="18" cy="8.5" r="3" />
      <path d="M18 11.5v8" />
      <path d="M18 15h3" />
      <path d="M18 17.5h2.5" />
    </svg>
  )
}
