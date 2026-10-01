"use client"

import { useEffect, useRef } from "react"
import { isLeaving } from "./finish"

/**
 * Browser Back steps back through a flow's own steps.
 *
 * ⚠ THE BUG THIS FIXES: Back on the password step did nothing. The steps live
 * in React state (resumable through sessionStorage, see ./resume.tsx), not in
 * history, so Back left for whatever entry came before - and when that entry
 * was this same page the form never moved, and a refresh restored the password
 * step again from storage. The page looked stuck in both directions.
 *
 * ⚠ AN ENTRY PER STEP, AT THE SAME URL. The user's rule is that nothing about
 * the flow goes in the address bar, so `pushState` gets no URL: the address
 * stays `/sign-in`, and the step rides in the entry's state. Next's app router
 * patches `pushState` and keeps its own keys alongside ours, so its Back
 * handling is undisturbed; the existing state is spread in for the same reason.
 *
 * `key` namespaces the step so the outer sign-in/sign-up switch and the
 * sign-in form's own steps can each keep theirs in one entry.
 */
const FIELD = "i10Step"

type StepState = Record<string, string>

function stepsIn(state: unknown): StepState {
  const value = (state as Record<string, unknown> | null)?.[FIELD]
  return value && typeof value === "object" ? (value as StepState) : {}
}

export function useStepHistory<S extends string>(
  key: string,
  step: S,
  home: S,
  onBack: (step: S) => void,
): void {
  const onBackRef = useRef(onBack)
  useEffect(() => {
    onBackRef.current = onBack
  })

  // Moving forward to a step pushes an entry for it, once.
  useEffect(() => {
    if (step === home) return
    const state = window.history.state as Record<string, unknown> | null
    const steps = stepsIn(state)
    if (steps[key] === step) return
    window.history.pushState({ ...state, [FIELD]: { ...steps, [key]: step } }, "")
  }, [key, step, home])

  // Back (or Forward) lands on an entry; the form follows it.
  useEffect(() => {
    function onPop(event: PopStateEvent) {
      // Never re-render a step under a page that is already leaving.
      if (isLeaving()) return
      const target = (stepsIn(event.state)[key] as S | undefined) ?? home
      onBackRef.current(target)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [key, home])
}

/**
 * Leave a step the way Back would, so the in-page "Change" button and the
 * browser button share one history: pop our own entry when we are on it,
 * otherwise just go home.
 */
export function stepBack(key: string, step: string, goHome: () => void): void {
  if (stepsIn(window.history.state)[key] === step) window.history.back()
  else goHome()
}
