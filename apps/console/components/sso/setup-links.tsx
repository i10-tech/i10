"use client"

import * as React from "react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Time } from "@/components/time"
import { useResetOnOpen } from "@/lib/react"
import { createSetupLink, revokeSetupLink, setupLinks } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { SetupLink, SsoConnection } from "@/lib/sso-types"
import { Block, Loading, ShownOnce, useRemote, useSsoCall } from "./shared"

/**
 * Setup links (sso.md 2.10): a link for the company's IT contact, who has no
 * account here, to enter the provider's settings and run a test. It can never
 * activate the connection, change enforcement, add domains or read a secret.
 *
 * ⚠ THE LINK IS SHOWN ONCE, when it is made. The API keeps only its hash, so
 * there is no way to see it again; make another and revoke the lost one.
 */

const HOURS = [
  { value: "24", label: "1 day" },
  { value: "72", label: "3 days" },
  { value: "168", label: "7 days" },
]

export function SetupLinks({
  connection,
  authOrigin,
}: {
  connection: SsoConnection
  authOrigin: string | null
}) {
  const call = useSsoCall()
  const { data, setData, failed } = useRemote(() => setupLinks(connection.id))
  const [making, setMaking] = React.useState(false)
  const [revoking, setRevoking] = React.useState<SetupLink | null>(null)
  const [shown, setShown] = React.useState<string | null>(null)
  const inSetup = connection.status === "draft" || connection.status === "testing"

  return (
    <Block
      title="Setup links"
      description="Send your IT contact a link to enter the provider's settings and run a test without an account. It works only while the connection is in draft or testing."
      action={
        <Button
          size="sm"
          variant="secondary"
          disabled={!inSetup || !authOrigin}
          onClick={() => setMaking(true)}
        >
          New link
        </Button>
      }
    >
      {!inSetup && (
        <p className="text-sm text-muted-foreground">
          This connection has left setup, so its links were revoked. Move it back to
          setup to make a new one.
        </p>
      )}
      {!data ? (
        <Loading failed={failed} />
      ) : data.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No link made yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {data.data.map((link) => (
            <li key={link.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {link.contactEmail ?? "No contact named"}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  Made <Time iso={link.createdAt} />
                  {link.revokedAt
                    ? ` - revoked: ${link.revokedReason ?? ""}`
                    : link.live
                      ? ""
                      : " - expired"}
                  {link.usedAt ? " - opened" : ""}
                </span>
              </span>
              {link.live ? (
                <>
                  <Badge tone="success" size="sm">
                    Live
                  </Badge>
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(link)}>
                    Revoke
                  </Button>
                </>
              ) : (
                <Badge tone="neutral" size="sm">
                  {link.revokedAt ? "Revoked" : "Expired"}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      <MakeLink
        open={making}
        onOpenChange={setMaking}
        onMake={async (hours, email) => {
          const made = await call(
            () =>
              createSetupLink(connection.id, {
                expiresInHours: hours,
                contactEmail: email || null,
              }),
            { title: "Could not make the link" },
          )
          if (!made || !data) return false
          // ⚠ THE TOKEN LEAVES THE ROW AT ONCE: the list keeps no copy, and the
          // URL lives only in the dialog's state until it is closed.
          const { token, ...row } = made
          setData({ data: [row, ...data.data] })
          // ⚠ THE FRAGMENT, NEVER THE PATH: a fragment never reaches a server or
          // a proxy log; the setup page reads it and clears the address at once.
          setShown(`${authOrigin}/sso/setup#token=${token}`)
          return true
        }}
      />
      <Revoke
        link={revoking}
        onClose={() => setRevoking(null)}
        onRevoke={async (link, reason) => {
          const after = await call(
            () => revokeSetupLink(connection.id, link.id, reason),
            {
              stepUp: false,
              title: "Could not revoke the link",
            },
          )
          if (!after || !data) return false
          setData({ data: data.data.map((l) => (l.id === link.id ? after : l)) })
          toastDone("Link revoked")
          return true
        }}
      />
      <ShownOnce
        open={shown !== null}
        title="Your setup link"
        description="Send it to your IT contact. It is shown once and cannot be found again; if you lose it, make another."
        fields={shown ? [{ label: "Link", value: shown }] : []}
        onClose={() => setShown(null)}
      />
    </Block>
  )
}

function MakeLink({
  open,
  onOpenChange,
  onMake,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onMake: (hours: number, email: string) => Promise<boolean>
}) {
  const [hours, setHours] = React.useState("72")
  const [email, setEmail] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  useResetOnOpen(open, () => {
    setHours("72")
    setEmail("")
    setBusy(false)
  })
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        title="New setup link"
        description="Whoever has the link can edit this connection's provider settings until it expires or you revoke it."
        style={{ width: "min(calc(100vw - 2rem), 448px)" }}
      >
        <div className="space-y-4 py-4">
          <MorphSelect
            label="Valid for"
            value={hours}
            onValueChange={setHours}
            items={HOURS}
          />
          <FloatingInput
            label="Contact's email (optional)"
            hint="Only a label for you. We do not send the link."
            type="email"
            value={email}
            maxLength={320}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                if (await onMake(Number(hours), email.trim())) onOpenChange(false)
              } finally {
                setBusy(false)
              }
            }}
          >
            Make link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Revoke({
  link,
  onClose,
  onRevoke,
}: {
  link: SetupLink | null
  onClose: () => void
  onRevoke: (link: SetupLink, reason: string) => Promise<boolean>
}) {
  const [reason, setReason] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  useResetOnOpen(link !== null, () => {
    setReason("")
    setBusy(false)
  })
  return (
    <Dialog open={link !== null} onOpenChange={(next) => !busy && !next && onClose()}>
      <DialogContent
        title="Revoke this link?"
        description="It stops working at once. Whoever has it can no longer open it."
        style={{ width: "min(calc(100vw - 2rem), 448px)" }}
      >
        <div className="py-4">
          <FloatingInput
            label="Why"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!reason.trim()}
            onClick={async () => {
              if (!link) return
              setBusy(true)
              try {
                if (await onRevoke(link, reason.trim())) onClose()
              } finally {
                setBusy(false)
              }
            }}
          >
            Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
