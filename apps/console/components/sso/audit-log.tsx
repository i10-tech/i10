"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ChevronRight } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Time } from "@/components/time"
import type { IdentityEvent } from "@/lib/sso-types"
import { ClerkMembers, memberLabel, type Member } from "./members"

/**
 * The identity audit log as a list: what happened, who did it, to whom, why,
 * and when, with the event's data one click away.
 *
 * ⚠ THE FILTER LIVES IN THE URL (`?user=`), so the server fetches the filtered
 * list and a filtered view can be linked. People are named from the Clerk
 * members when they load, and shown as ids otherwise.
 */

const ALL = "all"

/** "session.revoked" as "Session revoked". */
function typeLabel(type: string): string {
  const words = type.replaceAll(/[._]/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function AuditLog({
  events,
  user,
  limit,
  nextLimit,
  clerkEnabled,
}: {
  events: IdentityEvent[]
  user: string | null
  limit: number
  nextLimit: number | null
  clerkEnabled: boolean
}) {
  const router = useRouter()
  const [members, setMembers] = React.useState<Member[] | null>(null)
  const [typed, setTyped] = React.useState(user ?? "")
  const name = (id: string | null) => (id ? memberLabel(members, id) : "-")

  const go = (next: { user?: string | null; limit?: number }) => {
    const q = new URLSearchParams()
    const u = next.user === undefined ? user : next.user
    if (u) q.set("user", u)
    const l = next.limit ?? limit
    if (l !== 50) q.set("limit", String(l))
    const query = q.toString()
    router.push(`/settings/security/audit${query ? `?${query}` : ""}`)
  }

  return (
    <div className="space-y-4">
      {clerkEnabled && <ClerkMembers onMembers={setMembers} />}
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-72 max-w-full">
          {members && members.length > 0 ? (
            <MorphSelect
              label="Person"
              value={user ?? ALL}
              onValueChange={(v) => go({ user: v === ALL ? null : v })}
              items={[
                { value: ALL, label: "Everyone" },
                ...members.map((m) => ({ value: m.userId, label: m.label })),
              ]}
            />
          ) : (
            <FloatingInput
              label="Person's user id"
              hint="Starts with user_. Press Enter to filter."
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") go({ user: typed.trim() || null })
              }}
            />
          )}
        </div>
        {user && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTyped("")
              go({ user: null })
            }}
          >
            Clear filter
          </Button>
        )}
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {user ? "Nothing recorded for this person." : "Nothing recorded yet."}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {events.map((event) => (
            <Row key={event.id} event={event} name={name} />
          ))}
        </ul>
      )}

      {nextLimit !== null && events.length >= limit && (
        <Button variant="secondary" size="sm" onClick={() => go({ limit: nextLimit })}>
          Show {nextLimit}
        </Button>
      )}
      {nextLimit === null && events.length >= limit && (
        <p className="text-xs text-muted-foreground">
          Showing the newest {limit} events. Filter by person to look further back.
        </p>
      )}
    </div>
  )
}

function Row({
  event,
  name,
}: {
  event: IdentityEvent
  name: (id: string | null) => string
}) {
  const [open, setOpen] = React.useState(false)
  const id = React.useId()
  const hasData = Object.keys(event.data).length > 0
  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          disabled={!hasData}
          onClick={() => setOpen((o) => !o)}
          className="mt-0.5 text-muted-foreground disabled:opacity-30"
        >
          <ChevronRight
            className={`size-4 transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
          <span className="sr-only">{open ? "Hide data" : "Show data"}</span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{typeLabel(event.type)}</p>
          <p className="text-xs break-words text-muted-foreground">
            By {name(event.actorUserId)}
            {event.subjectUserId ? ` - for ${name(event.subjectUserId)}` : ""}
            {event.reason ? ` - ${event.reason.replaceAll("_", " ")}` : ""}
          </p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          <Time iso={event.createdAt} />
        </span>
      </div>
      {open && hasData && (
        <pre
          id={id}
          className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs"
        >
          {JSON.stringify(event.data, null, 2)}
        </pre>
      )}
    </li>
  )
}
