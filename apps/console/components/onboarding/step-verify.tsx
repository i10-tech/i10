"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CheckCircle2, ExternalLink } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { Status } from "@/components/status"
import { VerifyButton } from "@/components/verify-button"
import { EmptyState } from "@/components/empty-state"
import type { DomainSummary } from "@/lib/types"

/**
 * Waiting for DNS.
 *
 * ⚠ THIS STEP'S REAL JOB IS MANAGING EXPECTATIONS, NOT RUNNING A CHECK. DNS
 * propagation is minutes at best and up to 72 hours, and the failure mode of a
 * setup flow is somebody concluding after 90 seconds that it is broken and
 * changing records that were correct. Saying the number out loud is the whole
 * intervention.
 *
 * ⚠ AND IT POLLS RATHER THAN ASKING SOMEBODY TO KEEP PRESSING A BUTTON — but it
 * stops after a few minutes rather than hammering the API forever on a tab
 * somebody left open. The manual Verify button is always there.
 */
export function StepVerify({
  domains,
  justPublished = 0,
  onDone,
}: {
  domains: DomainSummary[]
  /**
   * Records the DNS callback wrote immediately before sending the browser here.
   *
   * ⚠ IT IS A PROP RATHER THAN A SCREEN OF ITS OWN, AND THAT IS THE FIX FOR A
   * BLIP. Connecting a provider used to end on the callback page's own
   * "Connected and published" tick, which then navigated here a few hundred
   * milliseconds later — so the confirmation appeared and was snatched away,
   * which reads as the interface glitching rather than as a step finishing.
   * The news arrives with the step instead: one screen, once, already carrying
   * it.
   */
  justPublished?: number
  onDone: () => void
}) {
  const router = useRouter()
  const pending = domains.filter((d) => d.status !== "verified")
  const verified = domains.filter((d) => d.status === "verified")

  const [polls, setPolls] = React.useState(0)
  const MAX_POLLS = 20

  React.useEffect(() => {
    if (pending.length === 0 || polls >= MAX_POLLS) return
    const timer = setTimeout(() => {
      setPolls((n) => n + 1)
      // ⚠ `router.refresh()` RE-RUNS THE SERVER COMPONENT, which re-reads the
      // domain list. It does NOT ask SES to re-check — that is what the Verify
      // button does. Polling a verification endpoint every ten seconds would be
      // a provider call per tab per person.
      router.refresh()
    }, 10_000)
    return () => clearTimeout(timer)
  }, [pending.length, polls, router])

  if (domains.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Verify your domain</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing to verify yet — add a domain first.
          </p>
        </div>
        <EmptyState
          title="No domains yet"
          description="Go back a step and add the domain you send from."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/*
       * ⚠ THE CONFIRMATION THE CALLBACK USED TO KEEP FOR ITSELF. It painted a
       * green tick, waited a few hundred milliseconds and navigated here — so
       * the one moment worth confirming was the one that flickered. It sits at
       * the top of the screen it was going to send you to anyway.
       *
       * ⚠ AND THE HEADING BELOW CHANGES WITH IT, because "Publish your records"
       * is instructions for work that has just been done for you. Telling
       * somebody to publish records we published ninety milliseconds ago is the
       * same wrongness as the blip, held still.
       */}
      {justPublished > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/5 p-4 duration-(--duration-instant) animate-in fade-in-0">
          <CheckCircle2
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-success"
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {justPublished === 1
                ? "Your record was added"
                : `Your ${justPublished} records were added`}
            </p>
            <p className="text-sm text-muted-foreground">
              We wrote them at your DNS provider and started checking. Nothing below
              needs doing — this page updates itself as they resolve.
            </p>
          </div>
        </div>
      )}

      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {justPublished > 0 ? "Checking your records" : "Publish your records"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {justPublished > 0
            ? "DNS usually propagates within minutes, but providers are allowed up to 72 hours — a pending domain is not a broken one."
            : "Open each domain to copy its records. DNS usually propagates within minutes, but providers are allowed up to 72 hours — a pending domain is not a broken one."}
        </p>
      </div>

      <ul className="divide-y overflow-hidden rounded-lg border">
        {domains.map((domain) => (
          <li
            key={domain.id}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-sm">{domain.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {domain.delegated
                  ? "Delegated — NS records to publish"
                  : "Manual — six records to publish"}
              </p>
            </div>

            <Status status={domain.status} />

            <div className="flex items-center gap-2">
              {/*
               * ⚠ THROUGH `/onboarding/skip`, NOT STRAIGHT AT THE DOMAIN PAGE,
               * AND THE DIRECT LINK IS WHY THIS BUTTON DID NOTHING. `/domains/…`
               * is under the console layout, which redirects to `/onboarding`
               * for as long as `should_onboard` is true — so the click
               * navigated, was bounced, and landed back on the screen it
               * started from. Exactly the bug "Skip to the console" had, which
               * is why that one is a route and not a link either.
               */}
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={`/onboarding/skip?to=${encodeURIComponent(`/domains/${domain.id}`)}`}
                >
                  Records
                  <ExternalLink />
                </Link>
              </Button>
              <VerifyButton id={domain.id} status={domain.status} />
            </div>
          </li>
        ))}
      </ul>

      {pending.length > 0 && polls < MAX_POLLS && (
        <p className="text-xs text-muted-foreground">
          Checking automatically every few seconds. You can carry on and come back —
          verification continues without this page open.
        </p>
      )}

      {pending.length > 0 && polls >= MAX_POLLS && (
        <p className="text-xs text-muted-foreground">
          Still waiting. That is normal — leave it with us and check back later, or
          press Verify to look again now.
        </p>
      )}

      {verified.length > 0 && (
        <Button onClick={onDone}>Continue with {verified[0]!.name}</Button>
      )}
    </div>
  )
}
