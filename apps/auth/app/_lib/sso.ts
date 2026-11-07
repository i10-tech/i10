"use client"

import type { SignInFlow } from "./clerk-types"
import { finalizeWithoutLeaving, leaveFor } from "./finish"

/**
 * The end of an SSO sign-in in the browser (#337, sso.md 2.1 steps 7 and 8):
 * swap the one-time code for a ticket, sign in with it, bind the new session.
 *
 * ⚠ THE SAME TICKET SIGN-IN AS A SAVED ACCOUNT (#192), `signIn.ticket()` and
 * `finalize`, with one step between finalizing and leaving: the bind. A
 * session that is not bound is refused by the API's gate for a managed
 * account and revoked by the sweeper two minutes later, so leaving before the
 * bind would land the person on a dashboard that refuses them.
 *
 * ⚠ ANY SESSION THIS BROWSER ALREADY HOLDS IS ENDED FIRST. Clerk will not sign
 * an account in twice (see `freshenAfterSignUp`), and a managed account's old
 * session is one the gate refuses anyway.
 *
 * Never throws: `null` when the browser is on its way out, otherwise the
 * message to show.
 */
export async function finishSso(
  signIn: Pick<SignInFlow, "ticket" | "finalize" | "status">,
  code: string,
  fallbackUrl: string,
): Promise<string | null> {
  const failed = "We could not finish signing you in. Start again."
  /*
   * ⚠ EVERY FAILURE NAMES ITS STEP, like `finalizeWithoutLeaving`. One run
   * (2026-11-01) showed this message with an active session and no bind
   * request, and could not be repeated; the dev servers forward the console,
   * so the next one arrives with the step and Clerk's reason.
   */
  const fail = (step: string, detail?: unknown) => {
    console.error(`[auth] sso finish failed at ${step}`, detail)
    return failed
  }
  try {
    const swap = await fetch("/api/sso/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    })
    const swapped = (await swap.json()) as { ticket?: string; message?: string }
    if (!swap.ok || !swapped.ticket) return swapped.message ?? failed

    const clerk = (
      window as {
        Clerk?: {
          session?: {
            getToken: () => Promise<string | null>
            end: () => Promise<unknown>
          } | null
        }
      }
    ).Clerk
    if (clerk?.session) await clerk.session.end()

    const { error } = await signIn.ticket({ ticket: swapped.ticket })
    if (error || signIn.status !== "complete")
      return fail("ticket", error ?? signIn.status)
    const { result } = await finalizeWithoutLeaving(
      (params) => signIn.finalize(params),
      fallbackUrl,
    )
    if (result.error) return fail("finalize", result.error)

    const token = await clerk?.session?.getToken()
    if (!token) return fail("token")
    const bound = await fetch("/api/sso/bind", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    })
    const answer = (await bound.json()) as {
      returnTo?: string | null
      message?: string
    }
    if (!bound.ok) {
      fail("bind", bound.status)
      return answer.message ?? failed
    }

    leaveFor(answer.returnTo ?? fallbackUrl)
    return null
  } catch (error) {
    return fail("threw", error)
  }
}
