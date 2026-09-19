"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
import { finishDnsConnect } from "@/lib/actions"

/**
 * Exchanging the authorisation code, exactly once.
 *
 * ⚠ THE GUARD IS NOT DEFENSIVE PROGRAMMING; AN AUTHORISATION CODE IS SINGLE
 * USE. React runs effects twice in development's strict mode and a router
 * refresh can re-render this, and the second exchange fails — with the provider
 * reporting an invalid code, which reads as "the connection is broken" on a
 * connection that was in fact created a moment earlier by the first call. The
 * ref is checked and set synchronously so two renders cannot both pass it.
 */
export function CallbackHandler({
  provider,
  code,
  state,
  providerError,
}: {
  provider: string
  code: string | null
  state: string | null
  providerError: string | null
}) {
  const router = useRouter()
  const started = React.useRef(false)
  const [status, setStatus] = React.useState<"working" | "done" | "failed">(
    providerError || !code || !state ? "failed" : "working",
  )
  const [message, setMessage] = React.useState<string | null>(
    providerError ?? (code && state ? null : "That link is missing its authorisation."),
  )

  React.useEffect(() => {
    if (started.current) return
    if (!code || !state || providerError) return
    started.current = true

    void (async () => {
      const result = await finishDnsConnect({ provider, code, state })
      if (!result.ok) {
        setStatus("failed")
        /*
         * ⚠ THE PROVIDER'S OWN WORDS, WHERE THE API SENT THEM. Every token
         * exchange that fails reads "X did not complete the authorisation",
         * which is true of an expired code, a rejected secret, a PKCE mismatch
         * and a bot-protection page alike — four failures with four different
         * next steps and one sentence between them. `detail` is the provider's
         * `error_description`, and the person reading it is the administrator
         * who authorised the account a moment ago.
         */
        const detail =
          typeof result.body?.detail === "string" ? result.body.detail : null
        setMessage(detail ? `${result.error} (${detail})` : result.error)
        return
      }
      setStatus("done")
      router.refresh()
    })()
  }, [code, state, provider, providerError, router])

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      {status === "working" && (
        <>
          <Spinner className="size-6" />
          <p className="text-sm text-muted-foreground">
            Finishing the connection with {provider}…
          </p>
        </>
      )}

      {status === "done" && (
        <>
          <CheckCircle2 className="size-8 text-success" />
          <div>
            <p className="text-sm font-medium">Connected</p>
            <p className="mt-1 text-sm text-muted-foreground">
              We can publish records for domains hosted at {provider}. Open a domain and
              press &ldquo;Publish these for me&rdquo;.
            </p>
          </div>
          <Button asChild>
            <Link href="/domains">Back to domains</Link>
          </Button>
        </>
      )}

      {status === "failed" && (
        <>
          <AlertTriangle className="size-8 text-danger" />
          <div>
            <p className="text-sm font-medium">That did not complete</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {message ?? "The authorisation could not be finished."}
            </p>
          </div>
          <Button variant="outline" asChild>
            <Link href="/domains">Back to domains</Link>
          </Button>
        </>
      )}
    </div>
  )
}
