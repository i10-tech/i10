"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { Spinner } from "@repo/ui/components/spinner"
import { finishDnsConnect, listDomains } from "@/lib/actions"
import { activateDomain } from "@/lib/domain-activation"

/**
 * Finishing the whole job, not just the authorisation.
 *
 * ⚠ CONNECTING USED TO BE ONE OF THREE THINGS SOMEBODY HAD TO DO, AND THE OTHER
 * TWO LOOKED OPTIONAL. You authorised the provider, came back to "Connected",
 * and then had to find the domain, press "Publish these for me", and press
 * "Verify" — three deliberate actions for one intention, with nothing on screen
 * saying the first had not finished anything. Authorising IS the instruction:
 * publish the records and check them, then say what happened.
 *
 * ⚠ THE GUARD IS NOT DEFENSIVE PROGRAMMING; AN AUTHORISATION CODE IS SINGLE
 * USE. React runs effects twice in development's strict mode and a router
 * refresh can re-render this, and the second exchange fails — with the provider
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
   * delegation shadows anything already at those names — a DMARC record is the
   * usual one — and removing it is never ours to decide unprompted. The API
   * answers 409 without writing, and this reports it rather than retrying with
   * `replace_conflicts`, which would be deciding by hand what the dialog on the
   * domain page exists to ask.
   */
  const [blocked, setBlocked] = React.useState<string[]>([])

  React.useEffect(() => {
    if (started.current) return
    if (!code || !state || providerError) return
    started.current = true

    void (async () => {
      const connected = await finishDnsConnect({ provider, code, state })
      if (!connected.ok) {
        setPhase("failed")
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
          typeof connected.body?.detail === "string" ? connected.body.detail : null
        setMessage(detail ? `${connected.error} (${detail})` : connected.error)
        return
      }

      setPhase("publishing")

      /*
       * ⚠ EVERY UNVERIFIED DOMAIN, NOT THE ONE THEY CAME FROM. The flow does
       * not carry a domain — somebody can reach this from onboarding, from the
       * add form or from a domain page — and a credential for a provider is a
       * credential for every zone in that account. Publishing for all of them
       * is what the customer asked for by connecting; a domain hosted
       * elsewhere answers `zone_not_found` and is skipped without comment.
       */
      const domains = await listDomains()
      const pending = domains.ok
        ? domains.data.data.filter((domain) => domain.status !== "verified")
        : []

      let wrote = 0
      const inTheWay: string[] = []

      /*
       * ⚠ THE SAME SEQUENCE THE ADD FORM AND THE ONBOARDING FLOW RUN, FROM THE
       * SAME FILE. Publishing and then checking was written out three times,
       * once per surface, and the three had drifted on what a 409 meant. See
       * lib/domain-activation.ts.
       *
       * ⚠ AND A "not yet" FROM THE CHECK IS NOT A FAILURE. The records were
       * written seconds ago; the check is a head start rather than the verdict,
       * and the domain page watches from here on.
       */
      for (const domain of pending) {
        const outcome = await activateDomain({ domainId: domain.id, provider })

        if (outcome.kind === "conflicts") {
          inTheWay.push(domain.name)
          continue
        }
        if (outcome.kind === "failed") continue

        wrote += 1
      }

      setPublished(wrote)
      setBlocked(inTheWay)
      setPhase("done")
      router.refresh()

      /*
       * ⚠ BACK WHERE THEY STARTED, IF THEY STARTED SOMEWHERE. The path came out
       * of the signed `state` and the API re-checked that it is a path on this
       * console. Without it, onboarding lost people here: the callback lands in
       * the console shell and the flow they were half-way through is not in it.
       *
       * ⚠ AND ONLY WHEN NOTHING NEEDS SAYING. A conflict is a decision waiting
       * for them; navigating away from it would hide the one thing on this page
       * that is not automatic.
       */
      const returnTo = connected.data.return_to
      if (returnTo && inTheWay.length === 0) router.replace(returnTo)
    })()
  }, [code, state, provider, providerError, router])

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      {(phase === "working" || phase === "publishing") && (
        <>
          <Spinner className="size-6" />
          <p className="text-sm text-muted-foreground">
            {phase === "working"
              ? `Finishing the connection with ${provider}…`
              : "Publishing your records and checking them…"}
          </p>
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
              ) : published > 0 ? (
                <>
                  We added the records at {provider} and proved the domains are yours.
                  Amazon&rsquo;s own check is the last step and usually lands within a
                  few minutes — the domain pages update themselves.
                </>
              ) : (
                <>
                  We can publish records for domains hosted at {provider}. Add a domain
                  and we will do the rest.
                </>
              )}
            </p>
          </div>
          <Button asChild>
            <Link href="/domains">Back to domains</Link>
          </Button>
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
          <Button variant="outline" asChild>
            <Link href="/domains">Back to domains</Link>
          </Button>
        </>
      )}
    </div>
  )
}
