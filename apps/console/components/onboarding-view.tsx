"use client"

import * as React from "react"
import Link from "next/link"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { Onboarding } from "@/components/onboarding/onboarding"
import { Wordmark } from "@/components/wordmark"
import { JoinSuggestions } from "@/components/join-suggestions"
import { Arrivals } from "@/components/arrivals"
import { ArrivalQuery } from "@/components/arrival-query"
import { ARRIVAL } from "@/lib/arrival"
import { OPEN_RAIL_ON_CURRENT } from "@/lib/step-rail"
import { RememberShape, useRememberedShape } from "@/components/list/remembered-shapes"
import {
  onboardingShape,
  type OnboardingData,
  type OnboardingShape,
} from "@/lib/shapes/onboarding"
import type { OnboardingState } from "@/lib/types"

export function OnboardingLoading() {
  return <OnboardingView shape={useRememberedShape(onboardingShape)} />
}

/** Set-up state for a workspace that does not exist yet: the very start. */
const NO_ONBOARDING: OnboardingState = {
  step: "workspace",
  completed_at: null,
  last_onboarded_plan: null,
  use_case: null,
  should_onboard: true,
  facts: { has_domain: false, has_verified_domain: false, has_api_key: false },
}

export function OnboardingView({
  shape,
  data,
}: {
  shape: OnboardingShape
  data?: OnboardingData
}) {
  const loading = data === undefined
  const noWorkspace = data ? data.noWorkspace : false
  const creating = data ? data.creating : shape.creating

  return (
    <BoneScope id="onboarding" loading={loading}>
      {/*
       * ⚠ EXACTLY ONE SCREEN TALL, AND IT DOES NOT SCROLL (2026-10-03). The steps
       * scroll inside their own column and the stage beside them stays put -
       * an overscroll at either end no longer drags the stage or the header.
       */}
      <main className="flex h-dvh flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
          <Link href="/" className="flex items-center">
            <Wordmark />
          </Link>
          {/*
           * ⚠ "Skip to the dashboard" RATHER THAN A CLOSE ICON. An × in the corner
           * of a set-up flow reads as "cancel", and people hesitate over whether
           * cancelling loses the domain they just added. Words say what happens.
           *
           * ⚠ AND IT POINTS AT `/onboarding/skip`, NOT AT `/`. The console layout
           * redirects here while `should_onboard` is true, so a link straight to
           * `/` was bounced back to this page - the button appeared to do nothing
           * at all. The route records the choice for this browser and then sends
           * them on. See lib/onboarding-skip.ts.
           *
           * ⚠ IT IS A PLAIN `<a>`, AND THAT IS THE WHOLE OF THE THIRD VERSION OF
           * THIS BUG. `next/link` does not navigate - it fetches the destination
           * as an RSC payload and swaps the tree client-side. `/onboarding/skip`
           * is a ROUTE HANDLER: it has no RSC payload, it answers a 307 with a
           * `Set-Cookie`, and the router has nothing it can do with that. So the
           * click fired `GET /onboarding/skip?_rsc=…`, the router discarded the
           * answer, the URL never changed and the cookie was never kept - the
           * button did nothing, again, for the third distinct reason, having twice
           * been fixed for doing nothing.
           *
           * A real anchor is a real navigation: the browser follows the redirect
           * and applies the cookie on the way through. `next/link` is for pages;
           * this is not one.
           */}
          {noWorkspace ? null : creating ? (
            // Nothing exists yet, so leaving is simply going back.
            <ButtonLink href="/" variant="ghost" size="sm">
              Cancel
            </ButtonLink>
          ) : (
            <ButtonLink href="/onboarding/skip" variant="ghost" size="sm" native>
              Skip to the dashboard
            </ButtonLink>
          )}
        </header>

        {loading ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[24rem_1fr] lg:grid-cols-[28rem_1fr]">
            <div className="overflow-y-auto border-r p-6">
              <div className="space-y-6">
                <div className="space-y-2">
                  <Bone id="step-title" width={180} lineHeight={24} />
                  <Bone id="step-desc" width="90%" lineHeight={16} />
                </div>
                <div className="space-y-4 pt-4">
                  <Bone id="input" shape="box" height={44} radius={8} />
                  <Bone id="button" shape="box" width={120} height={36} radius={8} />
                </div>
              </div>
            </div>
            <div className="hidden items-center justify-center bg-muted/20 p-8 md:flex">
              <Bone id="stage" shape="box" width={420} height={320} radius={16} />
            </div>
          </div>
        ) : (
          <>
            <ArrivalQuery names={[ARRIVAL.checkout, ARRIVAL.published]} />
            {/*
             * ⚠ FIRST, ABOVE SET-UP (2026-10-12). Somebody who signed up with an
             * @acme.com address may be setting up a workspace they do not need:
             * Acme's is already here, one request away.
             */}
            {/*
             * ⚠ "You joined Acme" COMES BEFORE EVERYTHING (#326): somebody auto-joined
             * at sign-up has a workspace already, and only needs to be told.
             */}
            {noWorkspace && (
              <Arrivals className="mx-auto w-full max-w-2xl shrink-0 px-6 pt-6" />
            )}
            {data.clerkOn && (
              <JoinSuggestions className="mx-auto w-full max-w-2xl shrink-0 px-6 pt-6" />
            )}
            <Onboarding
              creating={creating}
              state={
                creating
                  ? {
                      ...(data.me ? data.me.onboarding : NO_ONBOARDING),
                      step: "workspace",
                      completed_at: null,
                      facts: {
                        has_domain: false,
                        has_verified_domain: false,
                        has_api_key: false,
                      },
                    }
                  : data.me
                    ? data.me.onboarding
                    : NO_ONBOARDING
              }
              workspaceName={creating ? "" : (data.tenantOf?.name ?? "")}
              tenantId={creating ? "" : (data.tenantOf?.id ?? "")}
              domains={creating ? [] : data.domains}
              focus={!creating ? data.focus : null}
              domainDraft={creating ? null : data.domainDraft}
              offers={data.offers}
              userEmail={data.userEmail}
              firstName={data.firstName}
              plans={data.plans}
              billing={data.billing}
              checkoutId={data.checkoutId}
              // Somebody who joined a workspace its owner already named and set up.
              joined={
                !creating &&
                data.me !== null &&
                data.me.access !== null &&
                data.me.access.role !== "owner"
              }
              // ⚠ HOW THEY LAND ON THE STEP THEY LEFT FROM - a reload, or a return
              // from checkout, would otherwise re-derive from the facts and put
              // somebody who paid on the last step back on "Verify". From a cookie,
              // not `?step=`; see lib/onboarding-step.ts.
              resumeStep={data.resumeStep}
              // ⚠ ONLY THIS WORKSPACE'S DOMAINS COUNT. The cookie is the browser's,
              // not the account's, so it carries the ids the DNS callback published
              // and the list above - scoped by the API to whoever is signed in - is
              // what decides which of them are news here. See the callback handler.
              justPublished={data.justPublished}
            />
            {/* Opens a resumed flow on its step before the first paint. */}
            {/* eslint-disable-next-line react/no-danger -- static script, no user data */}
            <script dangerouslySetInnerHTML={{ __html: OPEN_RAIL_ON_CURRENT }} />
          </>
        )}
      </main>
      {data && <RememberShape def={onboardingShape} shape={shape} />}
    </BoneScope>
  )
}
