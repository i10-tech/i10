"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { TextShimmer } from "@repo/ui/components/text-shimmer/text-shimmer"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import {
  handOverPath,
  providerLabel,
  runDnsConnect,
  stageProblem,
  type DomainResult,
} from "@/lib/dns-connect"
import { ARRIVAL, setArrival } from "@/lib/arrival"

/**
 * Finishing the whole job, not just the authorisation.
 *
 * ⚠ CONNECTING USED TO BE ONE OF THREE THINGS SOMEBODY HAD TO DO, AND THE OTHER
 * TWO LOOKED OPTIONAL. You authorised the provider, came back to "Connected",
 * and then had to find the domain, press "Publish these for me", and press
 * "Verify" - three deliberate actions for one intention, with nothing on screen
 * saying the first had not finished anything. Authorising IS the instruction:
 * publish the records and check them, then say what happened.
 *
 * ⚠ THE GUARD IS NOT DEFENSIVE PROGRAMMING; AN AUTHORISATION CODE IS SINGLE
 * USE. React runs effects twice in development's strict mode and a router
 * refresh can re-render this, and the second exchange fails - with the provider
 * reporting an invalid code, which reads as "the connection is broken" on a
 * connection that was in fact created a moment earlier by the first call. The
 * ref is checked and set synchronously so two renders cannot both pass it.
 */

type Phase = "working" | "publishing" | "done" | "failed"

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
  const [phase, setPhase] = React.useState<Phase>(
    providerError || !code || !state ? "failed" : "working",
  )
  const [message, setMessage] = React.useState<string | null>(
    providerError ?? (code && state ? null : "That link is missing its authorisation."),
  )
  /**
   * How each unfinished domain ended, one line each.
   *
   * ⚠ ONE LINE PER DOMAIN, NOT ONE VERDICT FOR THE RUN. This screen used to pick
   * a single sentence by priority, so a refused domain hid a published one, and
   * "we proved the domains are yours" was said whenever anything was written -
   * including after a check that did not answer.
   *
   * ⚠ AND IT STILL NEVER REMOVES ANYBODY'S RECORDS. A domain with records in the
   * way ends `blocked`, and the domain page's dialog is what asks.
   */
  const [results, setResults] = React.useState<DomainResult[]>([])
  const providerName = providerLabel(provider)

  React.useEffect(() => {
    if (started.current) return
    if (!code || !state || providerError) return
    started.current = true

    /*
     * ⚠ STARTED FROM THE ADD-DOMAIN STEPS, IT IS FINISHED WHERE THEY RETURN
     * (2026-10-13) - set-up's verify step or the new domain's page. This page
     * used to shimmer "Finishing the connection" and "Publishing your records"
     * on an empty screen and then jump; now the code is handed over at once
     * and that page runs the same phases under the domain's events.
     */
    const back = handOverPath(provider, code, state)
    if (back) {
      router.replace(back)
      return
    }

    void (async () => {
      const outcome = await runDnsConnect({
        provider,
        code,
        state,
        onDomain: (_, stage) => {
          if (stage.kind === "publishing") setPhase("publishing")
        },
      })
      if (!outcome.ok) {
        setPhase("failed")
        setMessage(outcome.error ?? null)
        return
      }

      setResults(outcome.results)
      router.refresh()

      const returnTo = outcome.returnTo
      const clean = outcome.results.every(
        (r) => r.stage.kind === "published" && r.stage.checked,
      )
      if (returnTo && clean) {
        const [path = "/"] = returnTo.split("?")
        setArrival(ARRIVAL.published, outcome.results.map((r) => r.id).join(","), path)
        router.replace(returnTo)
        return
      }

      setPhase("done")
    })()
  }, [code, state, provider, providerError, router])

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      {(phase === "working" || phase === "publishing") && (
        <>
          <TextShimmer as="p" className="text-sm text-muted-foreground">
            {phase === "working"
              ? `Finishing the connection with ${providerName}`
              : "Publishing your records and checking them"}
          </TextShimmer>
        </>
      )}

      {phase === "done" && (
        <>
          {results.some((r) => r.stage.kind !== "published") ? (
            <AlertTriangle className="size-8 text-warning" />
          ) : (
            <CheckCircle2 className="size-8 text-success" />
          )}
          <div>
            <p className="text-sm font-medium">
              {results.some((r) => r.stage.kind === "published")
                ? "Connected and published"
                : "Connected"}
            </p>
            <div className="mt-1 space-y-1 text-sm text-muted-foreground">
              {results.length === 0 ? (
                <p>
                  We can publish records for domains hosted at {providerName}. Add a
                  domain and we will do the rest.
                </p>
              ) : (
                results.map((r) => (
                  <p key={r.id}>
                    {stageProblem(r.stage, r.name, providerName) ??
                      (r.stage.kind === "published" && r.stage.checked
                        ? `We added the records for ${r.name} at ${providerName}. Verification usually follows within a few minutes - the domain page updates itself.`
                        : `We added the records for ${r.name} at ${providerName}, but the check that follows did not answer. Open the domain and press Verify, and tell us if that keeps failing.`)}
                  </p>
                ))
              )}
            </div>
          </div>
          <ButtonLink href="/domains">Back to domains</ButtonLink>
        </>
      )}

      {phase === "failed" && (
        <>
          <AlertTriangle className="size-8 text-danger" />
          <div>
            <p className="text-sm font-medium">That did not complete</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {message ?? "The authorisation could not be finished."}
            </p>
          </div>
          <ButtonLink href="/domains" variant="secondary">
            Back to domains
          </ButtonLink>
        </>
      )}
    </div>
  )
}
