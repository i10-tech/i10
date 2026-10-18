import type { Metadata } from "next"

export const metadata: Metadata = { title: "Invitation" }

const COPY: Record<string, { title: string; body: string }> = {
  expired: {
    title: "This invitation has expired",
    body: "Ask whoever invited you to send a new one.",
  },
  full: {
    title: "This workspace is full right now",
    body: "Your invitation is still open. Try the link again once its admins have made room, before it expires.",
  },
  ended: {
    title: "This invitation is no longer open",
    body: "It was accepted or withdrawn. If you still need access, ask whoever invited you.",
  },
  unavailable: {
    title: "We could not open this invitation",
    body: "Try the link again in a moment.",
  },
  missing: {
    title: "We could not find this invitation",
    body: "Check the link in your email, or ask whoever invited you to send a new one.",
  },
}

/** Where an invitation link lands when it cannot be used (#327). */
export default async function InviteEnded({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>
}) {
  const { reason } = await searchParams
  const copy = COPY[reason ?? ""] ?? COPY.missing!
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-xl font-medium tracking-tight">{copy.title}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{copy.body}</p>
    </main>
  )
}
