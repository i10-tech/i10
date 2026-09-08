"use client"

/**
 * Where the browser is likely to put its passkey prompt.
 *
 * ⚠ A HEURISTIC, AND NOTHING HERE CAN BE BETTER THAN ONE. The WebAuthn dialog
 * is drawn by the browser or the operating system, outside the page and outside
 * anything script may measure — there is no API that reports its position, and
 * there is deliberately not going to be one, because that would let a page
 * trace a fake dialog over a real one. So this reads the platform and picks the
 * place that is right MOST of the time, and the copy never claims certainty.
 *
 * ⚠ USER-AGENT SNIFFING, WHICH IS NORMALLY THE WRONG ANSWER, and is the right
 * one here only because the consequence of being wrong is a hint pointing at
 * the wrong third of the screen. Nothing about the flow depends on it: the
 * passkey works identically whatever this returns.
 */
export type PromptPlacement = "top" | "center" | "bottom"

export interface PasskeyEnvironment {
  placement: PromptPlacement
  /** Named in the copy, so the sentence matches what the person is looking at. */
  hint: string
}

/**
 * The neutral answer, and the one the server renders.
 *
 * ⚠ A MODULE CONSTANT, NOT A FRESH OBJECT. `useSyncExternalStore` compares
 * snapshots by identity: returning a new object each call makes React believe
 * the value changed on every render and it loops until it gives up.
 */
export const NEUTRAL_ENVIRONMENT: PasskeyEnvironment = {
  placement: "center",
  hint: "Look for your browser's prompt.",
}

/** Memoised for the same identity reason. The platform cannot change mid-visit. */
let cached: PasskeyEnvironment | null = null

export function passkeyEnvironment(): PasskeyEnvironment {
  return (cached ??= computeEnvironment())
}

function computeEnvironment(): PasskeyEnvironment {
  // ⚠ GUARDED, BECAUSE THIS FILE IS IMPORTED BY A COMPONENT THAT SERVER-RENDERS.
  // Touching `navigator` during SSR throws; returning the neutral answer means
  // the first paint is centred and the effect corrects it after mount.
  if (typeof navigator === "undefined") return NEUTRAL_ENVIRONMENT

  const ua = navigator.userAgent
  // `maxTouchPoints` rather than a phone regex: it is what actually separates a
  // device that shows a bottom sheet from one that shows a window, and it gets
  // an iPad — which reports a desktop UA — right.
  const touch = navigator.maxTouchPoints > 1

  if (touch) {
    return {
      placement: "bottom",
      hint: "Your device will slide a prompt up from the bottom of the screen.",
    }
  }

  const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)
  if (safari) {
    return {
      placement: "top",
      hint: "Safari shows the prompt just below the address bar.",
    }
  }

  if (/Windows/.test(ua)) {
    return {
      placement: "center",
      hint: "Windows will open a system window in the middle of the screen.",
    }
  }

  return {
    placement: "center",
    hint: "Your browser will open a prompt in the middle of the window.",
  }
}
