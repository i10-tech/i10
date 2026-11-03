"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import { TabsContent, TabsList, TabsTrigger } from "@repo/ui/components/tabs/tabs"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { UrlTabs } from "@/components/list/url-tabs"
import { changeSsoConnection, deleteSsoConnection } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { SsoAbilities, SsoConnection, SsoStatus } from "@/lib/sso-types"
import { AccessPanel } from "./access-panel"
import { IdpSetup } from "./idp-setup"
import { LdapPanel } from "./ldap"
import { SetupLinks } from "./setup-links"
import { StatusBadge, Value, useSsoCall } from "./shared"
import { TestRuns } from "./test-runs"

/**
 * One SSO connection: its lifecycle (draft, testing, active, disabled) in the
 * header, and its settings in tabs. The page holds the connection in state and
 * takes each write's answer, so nothing re-renders behind an open dialog.
 */

const TABS = ["setup", "test", "access", "links", "mail"] as const

type Move = { to: SsoStatus; label: string; done: string; destructive?: boolean }

/** What the lifecycle allows from here, as the API allows it. */
function movesFrom(status: SsoStatus): { primary: Move | null; others: Move[] } {
  switch (status) {
    case "draft":
      return {
        primary: { to: "testing", label: "Start testing", done: "Testing" },
        others: [],
      }
    case "testing":
      return {
        primary: { to: "active", label: "Activate", done: "Active" },
        others: [{ to: "draft", label: "Back to draft", done: "Draft" }],
      }
    case "active":
      return {
        primary: null,
        others: [
          { to: "disabled", label: "Disable", done: "Disabled", destructive: true },
          { to: "testing", label: "Back to testing", done: "Testing" },
        ],
      }
    case "disabled":
      return {
        primary: { to: "active", label: "Enable again", done: "Active" },
        others: [{ to: "testing", label: "Back to testing", done: "Testing" }],
      }
  }
}

export function ConnectionPage({
  initial,
  abilities,
  authOrigin,
  clerkEnabled,
  tab,
}: {
  initial: SsoConnection
  abilities: SsoAbilities
  authOrigin: string | null
  clerkEnabled: boolean
  tab: string | undefined
}) {
  const call = useSsoCall()
  const router = useRouter()
  const [connection, setConnection] = React.useState(initial)
  const [moving, setMoving] = React.useState<Move | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const { primary, others } = movesFrom(connection.status)
  const live = connection.status === "active" || connection.status === "disabled"

  const onChange = React.useCallback((next: SsoConnection) => setConnection(next), [])

  async function move(to: Move): Promise<boolean> {
    const after = await call(
      () => changeSsoConnection(connection.id, { status: to.to }),
      {
        title: `Could not move it to ${to.label.toLowerCase()}`,
      },
    )
    if (!after) return false
    setConnection({ ...connection, ...after, domains: connection.domains })
    toastDone(`Connection ${to.done.toLowerCase()}`)
    return true
  }

  return (
    <div>
      <Link
        href="/settings/security"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Security
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="truncate text-lg font-medium">{connection.name}</h2>
          <StatusBadge status={connection.status} />
        </div>
        <div className="flex items-center gap-2">
          {connection.status === "draft" && abilities.owner && (
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          )}
          {others.map((m) => (
            <Button
              key={m.to}
              variant={m.destructive ? "danger" : "secondary"}
              size="sm"
              disabled={busy}
              onClick={() => setMoving(m)}
            >
              {m.label}
            </Button>
          ))}
          {primary && (
            <Button size="sm" disabled={busy} onClick={() => setMoving(primary)}>
              {primary.label}
            </Button>
          )}
        </div>
      </div>

      {connection.status !== "draft" && authOrigin && (
        <div className="pb-4">
          <Value
            label="Sign-in link for your team"
            value={`${authOrigin}/sso/${connection.id}`}
          />
        </div>
      )}
      {live && !abilities.owner && (
        <p className="pb-4 text-sm text-muted-foreground">
          This connection is live. Changes to who it trusts are an owner&rsquo;s; you
          can still disable it.
        </p>
      )}

      <UrlTabs value={TABS.find((t) => t === tab)} fallback="setup">
        <TabsList>
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="test">Test</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="links">Setup links</TabsTrigger>
          <TabsTrigger value="mail">Mail</TabsTrigger>
        </TabsList>
        <TabsContent value="setup" className="m-0 pt-4">
          <IdpSetup connection={connection} abilities={abilities} />
        </TabsContent>
        <TabsContent value="test" className="m-0 pt-4">
          <TestRuns connection={connection} authOrigin={authOrigin} />
        </TabsContent>
        <TabsContent value="access" className="m-0 pt-4">
          <AccessPanel
            connection={connection}
            abilities={abilities}
            clerkEnabled={clerkEnabled}
            onChange={onChange}
          />
        </TabsContent>
        <TabsContent value="links" className="m-0 pt-4">
          <SetupLinks connection={connection} authOrigin={authOrigin} />
        </TabsContent>
        <TabsContent value="mail" className="m-0 pt-4">
          <LdapPanel connection={connection} abilities={abilities} />
        </TabsContent>
      </UrlTabs>

      <ConfirmDialog
        open={deleting}
        onOpenChange={(open) => !open && setDeleting(false)}
        title="Delete this draft?"
        description="It is removed for good, with its settings and test runs. The audit log keeps a record."
        confirmLabel="Delete"
        doneLabel="Deleted"
        destructive
        onConfirm={async () => {
          setBusy(true)
          try {
            const deleted = await call(() => deleteSsoConnection(connection.id), {
              title: "Could not delete the connection",
            })
            if (!deleted) return false
            toastDone("Connection deleted")
            router.push("/settings/security")
            router.refresh()
            return true
          } finally {
            setBusy(false)
          }
        }}
      />

      <ConfirmDialog
        open={moving !== null}
        onOpenChange={(open) => !open && setMoving(null)}
        title={moving ? `${moving.label}?` : ""}
        description={describe(moving, connection)}
        confirmLabel={moving?.label ?? "Confirm"}
        doneLabel={moving?.done ?? "Done"}
        destructive={moving?.destructive ?? false}
        onConfirm={async () => {
          if (!moving) return false
          setBusy(true)
          try {
            return await move(moving)
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}

function describe(move: Move | null, connection: SsoConnection): string {
  if (!move) return ""
  switch (move.to) {
    case "testing":
      return "Nobody signs in through it yet. You can run test sign-ins and edit every setting."
    case "active":
      return connection.enforcement === "required_domain" ||
        connection.enforcement === "required_all"
        ? "People will sign in through it, and the enforcement you set applies at once. Requiring SSO needs a test that passed in the last 24 hours."
        : "People at its domains can sign in through it. From now on its trust settings are an owner's to change."
    case "disabled":
      return "Nobody can sign in through it, and people it manages cannot sign in until you enable it again. Their accounts are kept."
    case "draft":
      return "Back to setup. It is not testable until you start testing again."
  }
}
