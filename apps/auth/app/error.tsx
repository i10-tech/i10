"use client"

import { useEffect } from "react"

/**
 * The boundary over every auth screen.
 *
 * ⚠ IT EXISTS BECAUSE THIS APP HAD NOTHING, AND THE COST OF THAT WAS MEASURED
 * RATHER THAN IMAGINED. With no `error.tsx` anywhere in the tree, a thrown
 * render error falls all the way through to Next's OWN built-in boundary — a
 * bare white page reading "This page couldn't load", with a Reload button and a
 * Back button and no styling of ours on it. That is what a missing
 * `TooltipProvider` produced on the two-factor step: the person was four screens
 * into creating an account and the interface simply ended.
 *
 * ⚠ AND THE PARTICULAR CRUELTY OF IT IS THAT THE ACCOUNT ALREADY EXISTS BY
 * THEN. This flow finalizes in the middle — see sign-up/sign-up-form.tsx — so a
 * crash on passkey, two-factor or providers happens to somebody who is already
 * signed up and already signed in, and who has just been told the page is
 * broken. Reload sends them back to the start of a sign-up they have finished.
 * So the way out offered here is the dashboard, not the form.
 *
 * ⚠ IT RENDERS NO CHROME AND IMPORTS ALMOST NOTHING. An error boundary that
 * itself depends on the module that threw cannot render, and the thing that
 * threw here was a shared UI component. React and the stylesheet only.
 */
export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // ⚠ THE ONLY PLACE THIS IS RECORDED. In production Next replaces the
    // message with a generic string before it reaches the browser, so the
    // console is where a developer with the tab open still sees the real one.
    console.error(error)
  }, [error])

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="space-y-2">
        <h1 className="text-lg font-semibold tracking-tight">
          Something on this page broke
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {/*
           * ⚠ "IF YOU WERE SIGNING UP" IS THE LOAD-BEARING SENTENCE. Everything
           * after the emailed code is optional enrichment on an account that is
           * already made; somebody who does not know that will assume they have
           * to start again, and starting again with the same address is a
           * refusal from Clerk that looks like a second failure.
           */}
          If you were part-way through signing up, your account was already created —
          you can carry on from the dashboard and add a passkey or two-factor from
          settings.
        </p>
        {error.digest && (
          <p className="pt-1 font-mono text-xs text-muted-foreground">{error.digest}</p>
        )}
      </div>

      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="cursor-pointer rounded-pill bg-foreground px-4 py-2 text-sm font-medium text-background"
        >
          Try this step again
        </button>
        {/*
         * ⚠ A PLAIN `<a>`, NOT `next/link`, AND THE LINT RULE IS WRONG HERE
         * RATHER THAN BEING WORKED AROUND. Its point is that `<Link>` gives a
         * client-side transition and prefetching — which is exactly what this
         * link must not do. Something in the React tree has just thrown; a soft
         * navigation keeps that tree, its providers and whatever state got it
         * into this condition. A document load is the only escape hatch that is
         * guaranteed to start from nothing, which is the entire job of the
         * control.
         */}
        <a
          href="/sign-in"
          className="text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          Start over
        </a>
      </div>
    </div>
  )
}
