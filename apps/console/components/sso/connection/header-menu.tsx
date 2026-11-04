"use client"

import * as React from "react"
import { DropdownMenuItem } from "@repo/ui/components/i10/menu"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { RowMenu } from "@/components/list/row-menu"
import { changeSsoConnection } from "@/lib/sso-actions"
import { toastDone } from "@/lib/toast"
import type { SsoConnection, SsoStatus } from "@/lib/sso-types"
import { useSsoCall } from "../shared"

export type Move = {
  to: SsoStatus
  label: string
  title: string
  description: string
  confirmLabel: string
  done: string
  destructive?: boolean
}

export function HeaderMenu({
  connection,
  domains,
  onChange,
}: {
  connection: SsoConnection
  domains: string
  onChange: (connection: SsoConnection) => void
}) {
  const call = useSsoCall()
  const [moving, setMoving] = React.useState<Move | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function executeMove(m: Move): Promise<boolean> {
    setBusy(true)
    try {
      const after = await call(
        () => changeSsoConnection(connection.id, { status: m.to }),
        { title: `Could not move to ${m.label.toLowerCase()}` },
      )
      if (!after) return false
      onChange({ ...connection, ...after, domains: connection.domains })
      toastDone(`Connection ${m.done.toLowerCase()}`)
      return true
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <RowMenu visible label={connection.name}>
        {connection.status === "active" && (
          <>
            <DropdownMenuItem
              onSelect={() =>
                setMoving({
                  to: "testing",
                  label: "Pause sign-ins to test",
                  title: "Pause sign-ins to test?",
                  description:
                    "Nobody signs in through it while in testing. You can run test sign-ins and edit settings.",
                  confirmLabel: "Pause sign-ins",
                  done: "Testing",
                })
              }
            >
              Pause sign-ins to test
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-danger"
              onSelect={() =>
                setMoving({
                  to: "disabled",
                  label: "Disable connection",
                  title: "Disable this connection?",
                  description:
                    "Nobody can sign in through it, and people it manages cannot sign in until you turn it back on. Their accounts are kept.",
                  confirmLabel: "Disable",
                  done: "Disabled",
                  destructive: true,
                })
              }
            >
              Disable connection
            </DropdownMenuItem>
          </>
        )}

        {connection.status === "disabled" && (
          <>
            <DropdownMenuItem
              onSelect={() =>
                setMoving({
                  to: "active",
                  label: "Turn on connection",
                  title: "Turn on connection?",
                  description: `People at ${domains} can sign in through this connection.`,
                  confirmLabel: "Turn on",
                  done: "Active",
                })
              }
            >
              Turn on connection
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                setMoving({
                  to: "testing",
                  label: "Pause sign-ins to test",
                  title: "Pause sign-ins to test?",
                  description:
                    "Move to testing mode to run tests and make configuration changes.",
                  confirmLabel: "Move to testing",
                  done: "Testing",
                })
              }
            >
              Pause sign-ins to test
            </DropdownMenuItem>
          </>
        )}

        {connection.status === "testing" && (
          <>
            <DropdownMenuItem
              onSelect={() =>
                setMoving({
                  to: "active",
                  label: "Turn on connection",
                  title: "Turn on connection?",
                  description: `People at ${domains} can sign in through this connection.`,
                  confirmLabel: "Turn on",
                  done: "Active",
                })
              }
            >
              Turn on connection
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                setMoving({
                  to: "draft",
                  label: "Return to setup",
                  title: "Return to setup?",
                  description:
                    "The connection will not be testable until you move it back to testing.",
                  confirmLabel: "Return to setup",
                  done: "Draft",
                })
              }
            >
              Return to setup
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-danger"
              onSelect={() =>
                setMoving({
                  to: "disabled",
                  label: "Disable connection",
                  title: "Disable this connection?",
                  description: "Nobody can sign in through it.",
                  confirmLabel: "Disable",
                  done: "Disabled",
                  destructive: true,
                })
              }
            >
              Disable connection
            </DropdownMenuItem>
          </>
        )}

        {connection.status === "draft" && (
          <DropdownMenuItem
            onSelect={() =>
              setMoving({
                to: "testing",
                label: "Move to testing",
                title: "Move to testing?",
                description:
                  "You can run test sign-ins and edit settings before turning it on.",
                confirmLabel: "Move to testing",
                done: "Testing",
              })
            }
          >
            Move to testing
          </DropdownMenuItem>
        )}
      </RowMenu>

      <ConfirmDialog
        open={moving !== null}
        onOpenChange={(open) => !busy && !open && setMoving(null)}
        title={moving?.title ?? ""}
        description={moving?.description ?? ""}
        confirmLabel={moving?.confirmLabel ?? "Confirm"}
        doneLabel={moving?.done ?? "Done"}
        ready={!busy}
        destructive={moving?.destructive ?? false}
        onConfirm={async () => {
          if (!moving) return false
          return await executeMove(moving)
        }}
      />
    </>
  )
}
