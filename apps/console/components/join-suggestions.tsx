"use client"

import * as React from "react"
import { useOrganizationList } from "@clerk/nextjs"
import { useRouter } from "next/navigation"
import { Check } from "lucide-react"
import { Avatar } from "@repo/ui/components/avatar/avatar"
import { Button } from "@repo/ui/components/button/button"
import { TextMorph } from "@repo/ui/components/text-morph/text-morph"
import { MotionItem, MotionList, clerkReason } from "@/components/account/shared"
import { toastError } from "@/lib/toast"
import { useJoinSuggestions } from "@/lib/join-suggestions"

const DISMISSED = "i10.join-suggestions.dismissed"

/*
 * The dismissed ids, read through `useSyncExternalStore`: local storage only
 * exists after hydration, and the server renders with nothing dismissed.
 */
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => {
  try {
    return window.localStorage.getItem(DISMISSED) ?? "[]"
  } catch {
    return "[]"
  }
}
function parse(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : []
  } catch {
    return []
  }
}

/**
 * "Acme uses i10" (2026-10-12): the workspaces a person is suggested or
 * invited to, as a card on onboarding and the overview.
 *
 * ⚠ THE SWITCHER WAS THE ONLY PLACE THIS SHOWED, and somebody who just signed
 * up with an @acme.com address lands in their own new workspace and never
 * opens it - so Acme turning suggestions on reached nobody. A suggestion is
 * a request: they ask, an admin at Acme accepts (Team > Requests). An
 * invitation is already accepted on the other side, so it joins at once.
 *
 * ⚠ "NOT NOW" IS PER BROWSER AND PER SUGGESTION, in local storage. It hides a
 * card somebody has read; the switcher still lists it, and a new suggestion
 * arrives as a new card.
 */
export function JoinSuggestions({ className }: { className?: string }) {
  const router = useRouter()
  // Invitations are Clerk's; suggestions are ours (see lib/join-suggestions).
  const { isLoaded, setActive, userInvitations } = useOrganizationList({
    userInvitations: { status: "pending", keepPreviousData: true },
  })
  const suggestions = useJoinSuggestions()
  const raw = React.useSyncExternalStore(subscribe, snapshot, () => "[]")
  const dismissed = React.useMemo(() => parse(raw), [raw])
  const [hidden, setHidden] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState<string | null>(null)

  if (!isLoaded || suggestions.list === null) return null

  type Row = {
    id: string
    name: string
    image?: string
    kind: "suggestion" | "invitation"
    requested: boolean
    act: () => Promise<void>
  }
  const rows: Row[] = [
    ...(userInvitations.data ?? []).map((invitation) => ({
      id: invitation.id,
      name: invitation.publicOrganizationData.name,
      image: invitation.publicOrganizationData.hasImage
        ? invitation.publicOrganizationData.imageUrl
        : undefined,
      kind: "invitation" as const,
      requested: false,
      act: async () => {
        await invitation.accept()
        await setActive?.({ organization: invitation.publicOrganizationData.id })
        router.push("/")
        router.refresh()
      },
    })),
    ...suggestions.list.map((suggestion) => ({
      id: `suggest:${suggestion.tenant_id}`,
      name: suggestion.name,
      image: suggestion.image_url ?? undefined,
      kind: "suggestion" as const,
      requested: suggestion.requested,
      act: async () => {
        const result = await suggestions.ask(suggestion.tenant_id)
        if (!result.ok) throw new Error(result.error)
      },
    })),
  ].filter((row) => !dismissed.includes(row.id) && !hidden.includes(row.id))
  // Nothing to say: no box, and no padding reserved for one.
  if (rows.length === 0) return null

  function dismiss(id: string) {
    // Hidden at once, even where storage is refused (a private window).
    setHidden((list) => [...list, id])
    try {
      window.localStorage.setItem(DISMISSED, JSON.stringify([...dismissed, id]))
      listeners.forEach((listener) => listener())
    } catch {
      /* hidden for this visit only */
    }
  }

  async function act(row: Row) {
    setBusy(row.id)
    try {
      await row.act()
    } catch (error) {
      toastError(
        row.kind === "invitation" ? "Could not join" : "Could not ask to join",
        // Clerk's reason for an invitation; ours (the API's message) for a request.
        clerkReason(error, error instanceof Error ? error.message : undefined),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={className}>
      <MotionList>
        {rows.map((row) => (
          <MotionItem key={row.id}>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4">
              <span className="flex min-w-0 items-center gap-3">
                <Avatar name={row.name} src={row.image} className="rounded-lg" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {row.kind === "invitation"
                      ? `You're invited to ${row.name}`
                      : `${row.name} uses i10`}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    <TextMorph>
                      {row.kind === "invitation"
                        ? "Join to see its domains, emails and settings."
                        : row.requested
                          ? "Asked. An admin there will let you in."
                          : "Your email address is at its domain. Ask to join and an admin there approves it."}
                    </TextMorph>
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {!row.requested && (
                  <Button variant="ghost" size="sm" onClick={() => dismiss(row.id)}>
                    Not now
                  </Button>
                )}
                {row.requested ? (
                  <span className="flex items-center gap-1.5 px-3 text-sm text-muted-foreground">
                    <Check className="size-4 text-success" aria-hidden />
                    Requested
                  </span>
                ) : (
                  <Button
                    size="sm"
                    loading={busy === row.id}
                    disabled={busy !== null}
                    onClick={() => void act(row)}
                  >
                    {row.kind === "invitation" ? "Join" : "Request to join"}
                  </Button>
                )}
              </span>
            </div>
          </MotionItem>
        ))}
      </MotionList>
    </div>
  )
}
