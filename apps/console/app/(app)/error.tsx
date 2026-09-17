"use client"

import { useEffect } from "react"
import { AlertTriangle, RotateCw } from "lucide-react"
import { Button } from "@repo/ui/components/button"

/**
 * When a page throws.
 *
 * ⚠ THE MESSAGE IS SHOWN, BUT IN PRODUCTION NEXT REPLACES IT WITH A GENERIC
 * STRING AND A DIGEST — deliberately, so a server stack trace never reaches a
 * browser. The digest is what correlates this screen with the entry in our
 * logs, which is why it is rendered rather than hidden: "it broke" plus an
 * eight-character code is a support conversation that takes one message.
 *
 * ⚠ AND `reset()` RE-RENDERS THE SEGMENT RATHER THAN RELOADING THE PAGE. A
 * transient failure — a database blip, a Clerk timeout — recovers without
 * losing the rest of the console.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // ⚠ CONSOLE ONLY. There is no client-side error reporter wired into the
    // console yet; logging it here at least puts it somewhere a developer with
    // the tab open can find it. The server side already reports through Sentry.
    console.error(error)
  }, [error])

  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-4 px-6 text-center">
      <AlertTriangle className="size-5 text-warning" />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted-foreground">{error.message}</p>
        {error.digest && (
          <p className="pt-1 font-mono text-2xs text-muted-foreground">
            {error.digest}
          </p>
        )}
      </div>
      <Button onClick={reset}>
        <RotateCw />
        Try again
      </Button>
    </div>
  )
}
