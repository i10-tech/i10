"use client"

import { useEffect } from "react"

/**
 * The boundary above the console shell.
 *
 * ⚠ IT EXISTS BECAUSE `(app)/error.tsx` CANNOT CATCH `(app)/layout.tsx`. Next's
 * rule is that an `error.tsx` covers its segment's PAGE and everything nested
 * below it, but not the layout alongside it — a layout error has to be caught
 * one level up. And `(app)/layout.tsx` is exactly where a failure is most
 * likely: it calls `/console/me` on every request, so an API that is down, a
 * Clerk outage, or a session that lapsed mid-navigation all throw there.
 * Without this file that becomes Next's own unstyled error page.
 *
 * ⚠ SO IT RENDERS ITS OWN CHROME, NOT THE CONSOLE'S. By the time this runs the
 * shell is the thing that failed; reaching for the sidebar would re-enter the
 * component that just threw. It is deliberately plain.
 *
 * ⚠ AND IT IS A CLIENT COMPONENT WITH NO IMPORTS FROM `@/lib`. An error
 * boundary that itself depends on the module that failed cannot render. The
 * only import is React.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">
          The console could not load
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {/*
           * ⚠ IN PRODUCTION NEXT REPLACES THIS MESSAGE WITH A GENERIC STRING
           * AND A DIGEST, deliberately, so a server stack trace never reaches a
           * browser. The digest below is what correlates this screen with the
           * entry in our logs — which is why it is rendered rather than hidden.
           */}
          {error.message}
        </p>
        {error.digest && (
          <p className="pt-1 font-mono text-xs text-muted-foreground">{error.digest}</p>
        )}
      </div>

      <button
        type="button"
        onClick={reset}
        className="cursor-pointer rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background"
      >
        Try again
      </button>
    </div>
  )
}
