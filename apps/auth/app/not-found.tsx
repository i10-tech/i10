import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@repo/ui/components/button"

export const metadata: Metadata = {
  title: "Not found · i10",
  // Same rule as the rest of this app: nothing here is worth indexing, and a
  // 404 on an auth origin in search results is a phishing target's first step.
  robots: { index: false, follow: false },
}

/**
 * The 404 for this origin.
 *
 * ⚠ IT IS THE CONSOLE'S PAGE, ON PURPOSE, RATHER THAN A SECOND DESIGN. These are
 * two apps on two subdomains and one product; somebody who mistypes a path on
 * `auth.` and one who mistypes on `dash.` should not be able to tell they were
 * handled by different codebases. Without this file Next serves its own built-in
 * 404 — unstyled Times New Roman on white, in dark mode, with no way back.
 *
 * ⚠ THE WAY OUT IS SIGN-IN RATHER THAN THE DASHBOARD, AND THAT IS THE ONE THING
 * THAT DIFFERS. This origin exists for people who do not have a session yet;
 * sending them to the console means a bounce straight back here with a
 * `redirect_url` they never asked for. The sign-in page is the thing this app
 * is for, and it is the correct destination whether or not they are signed in —
 * `/sign-in` with a live session forwards on by itself.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      {/*
       * ⚠ THE NUMBER IS DECORATION AND IS HIDDEN FROM SCREEN READERS. Read
       * aloud before the heading it is just "four zero four", which delays the
       * sentence that actually says what happened.
       */}
      <p
        aria-hidden
        className="font-mono text-6xl font-medium text-muted-foreground/25 tabular"
      >
        404
      </p>

      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">
          We could not find that page
        </h1>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          The link may be out of date. Everything on this address is signing in, signing
          up, or one of the steps in between.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button asChild>
          <Link href="/sign-in">Go to sign in</Link>
        </Button>
        <Button asChild variant="ghost">
          <a href="https://docs.i10.tech" target="_blank" rel="noreferrer">
            Read the docs
          </a>
        </Button>
      </div>
    </main>
  )
}
