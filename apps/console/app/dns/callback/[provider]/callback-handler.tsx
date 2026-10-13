"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { TextShimmer } from "@repo/ui/components/text-shimmer/text-shimmer"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { handOverPath, runDnsConnect } from "@/lib/dns-connect"
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
  const [published, setPublished] = React.useState(0)
  /**
   * ⚠ RECORDS SOMEBODY ELSE'S RECORDS ARE IN THE WAY, AND STOPS. Publishing a
   * delegation shadows anything already at those names - a DMARC record is the
   * usual one - and removing it is never ours to decide unprompted. The API
   * answers 409 without writing, and this reports it rather than retrying with
   * `replace_conflicts`, which would be deciding by hand what the dialog on the
   * domain page exists to ask.
   */
  const [blocked, setBlocked] = React.useState<string[]>([])
  /**
   * Records written, but the check that follows them did not answer.
   *
   * ⚠ IT IS A SEPARATE LIST BECAUSE IT USED TO BE SILENTLY FOLDED INTO
   * SUCCESS. A verify that answered 500 still counted as published, so this
   * screen said "we proved the domains are yours" - two claims, one measured
   * and one invented - and the person had no reason to look any further. The
   * failing call stayed invisible until they pressed Verify by hand.
   */
  const [unchecked, setUnchecked] = React.useState<string[]>([])

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
        onPhase: (next) => {
          if (next === "checking") setPhase("publishing")
        },
      })
      if (!outcome.ok) {
        setPhase("failed")
        setMessage(outcome.error ?? null)
        return
      }

      setPublished(outcome.publishedIds.length)
      setBlocked(outcome.blocked)
      setUnchecked(outcome.unchecked)
      router.refresh()

      const returnTo = outcome.returnTo
      if (returnTo && outcome.blocked.length === 0 && outcome.unchecked.length === 0) {
        const [path = "/"] = returnTo.split("?")
        setArrival(ARRIVAL.published, outcome.publishedIds.join(","), path)
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
              ? `Finishing the connection with ${provider}`
              : "Publishing your records and checking them"}
          </TextShimmer>
        </>
      )}

      {phase === "done" && (
        <>
          <CheckCircle2 className="size-8 text-success" />
          <div>
            <p className="text-sm font-medium">
              {published > 0 ? "Connected and published" : "Connected"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {blocked.length > 0 ? (
                <>
                  We published what we could, but {blocked.join(", ")} already{" "}
                  {blocked.length === 1 ? "has records" : "have records"} at the names
                  we need. Open {blocked.length === 1 ? "it" : "them"} to choose whether
                  to replace {blocked.length === 1 ? "them" : "those"}.
                </>
              ) : unchecked.length > 0 ? (
                <>
                  We added the records at {provider}, but the check that follows them
                  did not answer for {unchecked.join(", ")}. The records are in place -
                  open the domain and press Verify, and tell us if that keeps failing.
                </>
              ) : published > 0 ? (
                <>
                  We added the records at {provider} and proved the domains are yours.
                  Amazon&rsquo;s own check is the last step and usually lands within a
                  few minutes - the domain pages update themselves.
                </>
              ) : (
                <>
                  We can publish records for domains hosted at {provider}. Add a domain
                  and we will do the rest.
                </>
              )}
            </p>
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
