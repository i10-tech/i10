"use client"

/**
 * The page's half of "press your saved account and you are back in" (#192).
 *
 * The secrets live in an httpOnly cookie this script cannot read - see
 * ./devices-server.ts. These only ask this origin's own routes to use it.
 */

interface ClerkLike {
  user?: { primaryEmailAddress?: { emailAddress: string } | null } | null
  session?: { getToken: () => Promise<string | null> } | null
}

const clerk = () => (window as { Clerk?: ClerkLike }).Clerk

/**
 * ⚠ BOUNDED, BECAUSE IT RUNS ON THE WAY OUT. `leaveFor` waits for this before
 * navigating; a slow API must cost the person at most this long, after which
 * they leave and simply are not remembered this time.
 */
const REMEMBER_BUDGET_MS = 1500

/** After a real sign-in. Never throws, never takes longer than the budget. */
export async function rememberDevice(): Promise<void> {
  const work = (async () => {
    const email = clerk()?.user?.primaryEmailAddress?.emailAddress
    const token = await clerk()?.session?.getToken()
    if (!email || !token) return
    await fetch("/api/devices/remember", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ email }),
      // Survives the navigation if the budget runs out first.
      keepalive: true,
    })
  })().catch(() => undefined)

  await Promise.race([
    work,
    new Promise((resolve) => setTimeout(resolve, REMEMBER_BUDGET_MS)),
  ])
}

export type ResumeAnswer =
  | { outcome: "ticket"; ticket: string; secondFactor: boolean }
  | { outcome: "passkey" }
  | { outcome: "signin" }

/** A card was pressed. Anything unexpected is the ordinary flow. */
export async function resumeDevice(email: string): Promise<ResumeAnswer> {
  try {
    const response = await fetch("/api/devices/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    })
    if (!response.ok) return { outcome: "signin" }
    const answer = (await response.json()) as ResumeAnswer
    return answer.outcome === "ticket" || answer.outcome === "passkey"
      ? answer
      : { outcome: "signin" }
  } catch {
    return { outcome: "signin" }
  }
}

/** The card's ×. Fire and forget: the card is already gone from the page. */
export function forgetDevice(email: string): void {
  void fetch("/api/devices/forget", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
    keepalive: true,
  }).catch(() => undefined)
}
