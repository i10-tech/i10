"use client"

import * as React from "react"
import Link from "next/link"
import { CheckCircle2, ExternalLink } from "lucide-react"
import { Button } from "@repo/ui/components/button"
import { Reveal } from "@repo/ui/components/reveal"
import { Swap } from "@repo/ui/components/swap"
import { Status } from "@/components/status"
import { VerifyButton } from "@/components/verify-button"
import { EmptyState } from "@/components/empty-state"
import { refreshDomain, verifyDomain } from "@/lib/actions"
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
 * ⚠ AND IT POLLS RATHER THAN ASKING SOMEBODY TO KEEP PRESSING A BUTTON - but it
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
   * milliseconds later - so the confirmation appeared and was snatched away,
   * which reads as the interface glitching rather than as a step finishing.
   * The news arrives with the step instead: one screen, once, already carrying
   * it.
   */
  justPublished?: number
  onDone: () => void
}) {
  const pending = domains.filter((d) => d.status !== "verified")
  const verified = domains.filter((d) => d.status === "verified")

  const [polls, setPolls] = React.useState(0)
  const MAX_POLLS = 20

  /*
   * ⚠ EACH TICK ASKS THE QUESTION, NOT JUST THE PAGE. This used to be a bare
   * `router.refresh()`, which re-reads our table - and a domain whose one
   * verify after publishing arrived before DNS was serving sits at
   * `not_started` in that table, with no SES identity, until somebody presses
   * Verify or the minutely prover gets round to it. So a domain added through
   * the Cloudflare hand-off reached SES a minute or more late, while the same
   * domain added from /domains/new - whose page runs `DomainLiveProvider` -
   * reached it within seconds. Now both ask the same way: `verify` while a
   * domain is unregistered, `refresh` once SES has it. See
   * `watchUntilVerified` for the rule, and lib/actions.ts for why neither needs
   * a refresh afterwards - each re-renders this page in its own response.
   *
   * ⚠ THE FIRST TICK IS QUICK FOR THE SAME REASON. Ten seconds was a fine
   * interval for re-reading a list; it is a long time for the moment
   * somebody lands here straight from their DNS provider.
   */
  // ⚠ THE IDS AND STATUSES, NOT THE ARRAY, which is a new object on every
  // render and would reset the timer each time the page re-renders.
  const watched = pending.map((d) => `${d.id}:${d.status}`).join(",")

  React.useEffect(() => {
    if (pending.length === 0 || polls >= MAX_POLLS) return
    const timer = setTimeout(
      () => {
        setPolls((n) => n + 1)
        void Promise.all(
          pending.map((domain) =>
            domain.status === "not_started"
              ? verifyDomain(domain.id)
              : refreshDomain(domain.id),
          ),
        )
      },
      polls === 0 ? 2_000 : 10_000,
    )
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `watched` is `pending`, keyed
  }, [watched, polls])

  if (domains.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Verify your domain</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing to verify yet - add a domain first.
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
       * green tick, waited a few hundred milliseconds and navigated here - so
       * the one moment worth confirming was the one that flickered. It sits at
       * the top of the screen it was going to send you to anyway.
       *
       * ⚠ AND THE HEADING BELOW CHANGES WITH IT, because "Publish your records"
       * is instructions for work that has just been done for you. Telling
       * somebody to publish records we published ninety milliseconds ago is the
       * same wrongness as the blip, held still.
       */}
      {justPublished > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success/5 p-4 motion-surface animate-[surface-enter_var(--duration-instant)_var(--ease-linear)]">
          <CheckCircle2
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-success"
          />
          <div className="space-y-1">
            {/*
             * ⚠ THE COUNT IS DOMAINS, NOT RECORDS, AND THE OLD COPY SPENT IT
             * AS THOUGH IT WERE RECORDS. One domain read "Your record was
             * added" - singular, about the six records we had just written -
             * and two domains read "Your 2 records were added", which names
             * the wrong unit and a number a third of the real one. The
             * sentence beneath it has always said "We wrote them".
             */}
            <p className="text-sm font-medium">
              {justPublished === 1
                ? "Your records were added"
                : `Your records were added for ${justPublished} domains`}
            </p>
            <p className="text-sm text-muted-foreground">
              We wrote them at your DNS provider and started checking. Nothing below
              needs doing - this page updates itself as they resolve.
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
            ? "DNS usually propagates within minutes, but providers are allowed up to 72 hours - a pending domain is not a broken one."
            : "Open each domain to copy its records. DNS usually propagates within minutes, but providers are allowed up to 72 hours - a pending domain is not a broken one."}
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
                  ? "Delegated - NS records to publish"
                  : "Manual - six records to publish"}
              </p>
            </div>

            <Status status={domain.status} />

            <div className="flex items-center gap-2">
              {/*
               * ⚠ THROUGH `/onboarding/skip`, NOT STRAIGHT AT THE DOMAIN PAGE,
               * AND THE DIRECT LINK IS WHY THIS BUTTON DID NOTHING. `/domains/…`
               * is under the console layout, which redirects to `/onboarding`
               * for as long as `should_onboard` is true - so the click
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

      {/*
       * ⚠ EVERYTHING BELOW THE LIST CHANGES WHILE SOMEBODY IS WATCHING IT, SO
       * NONE OF IT MAY APPEAR IN ONE FRAME. This page polls: a domain verifies
       * on its own, the "checking" line goes, and Continue arrives - each of
       * which used to be conditional JSX that popped in and shoved the rest.
       * Now the line changes its words in place and the button grows into the
       * space it needs, on the same spring as every other reveal.
       *
       * ⚠ THE WRAPPER IS ALWAYS RENDERED, which is what keeps the gap above
       * it constant: in a `space-y` stack the gap belongs to the element
       * BEFORE, and it only has one while something follows it.
       */}
      <div>
        <Reveal show={pending.length > 0} spacing="pb-6">
          <p className="text-xs text-muted-foreground">
            <Swap id={polls < MAX_POLLS ? "polling" : "waiting"}>
              {polls < MAX_POLLS
                ? "Checking automatically every few seconds. You can carry on and come back - verification continues without this page open."
                : "Still waiting. That is normal - leave it with us and check back later, or press Verify to look again now."}
            </Swap>
          </p>
        </Reveal>

        <Reveal show={verified.length > 0} spacing="">
          {verified[0] && (
            <Button onClick={onDone}>Continue with {verified[0].name}</Button>
          )}
        </Reveal>
      </div>
    </div>
  )
}
