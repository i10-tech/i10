"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Spinner } from "@repo/ui/components/spinner"
import { Button } from "@repo/ui/components/button"

/**
 * The first ten seconds of a brand-new account.
 *
 * ⚠ THIS IS NOT AN ERROR STATE AND MUST NEVER LOOK LIKE ONE. The API answered
 * 409 `tenant_not_ready`, which means the person is signed in and entitled to
 * an account — the row simply does not exist yet, because provisioning runs off
 * a Clerk webhook that Svix may still be retrying. Rendering "access denied" on
 * somebody's first visit makes them sign up a second time, which creates a
 * second organization and a second tenant, and now they genuinely do have two
 * accounts.
 *
 * ⚠ IT RETRIES ON A BACKOFF AND THEN STOPS, RATHER THAN POLLING FOREVER. A
 * webhook that has not landed in half a minute is not going to land because we
 * asked eight hundred more times; at that point the honest thing is a button
 * and a support line. The backoff also means a genuinely broken provisioning
 * path does not have every new signup hammering the API.
 */
const DELAYS = [1000, 2000, 3000, 5000, 8000, 13000]

export function TenantNotReady() {
  const router = useRouter()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (attempt >= DELAYS.length) return
    const timer = setTimeout(() => {
      setAttempt((n) => n + 1)
      // ⚠ `router.refresh()`, NOT `location.reload()`. A full reload throws away
      // the React tree and re-runs Clerk's client bootstrap, which is a visible
      // white flash every second or two. `refresh` re-runs the server
      // components in place — the layout calls `/console/me` again and renders
      // the real console the moment the row exists.
      router.refresh()
    }, DELAYS[attempt])
    return () => clearTimeout(timer)
  }, [attempt, router])

  const givenUp = attempt >= DELAYS.length

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      {!givenUp && <Spinner className="size-5 text-muted-foreground" />}
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold tracking-tight">
          {givenUp ? "This is taking longer than it should" : "Setting up your workspace"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {givenUp
            ? "Your account exists, but the workspace behind it has not finished being created. Reloading sometimes clears it; if not, we would like to know."
            : "This usually takes a couple of seconds. We are waiting for your account to finish being created."}
        </p>
      </div>
      {givenUp && (
        <div className="flex gap-2">
          <Button onClick={() => router.refresh()}>Try again</Button>
          <Button variant="outline" asChild>
            <a href="mailto:support@i10.tech">Contact support</a>
          </Button>
        </div>
      )}
    </main>
  )
}
