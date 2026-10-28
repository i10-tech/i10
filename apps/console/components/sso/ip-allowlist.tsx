"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingTextarea } from "@repo/ui/components/i10/floating-field"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Time } from "@/components/time"
import { parseRanges, rangesToText, sameRanges } from "@/lib/ip-ranges"
import { ipAllowlist, saveIpAllowlist } from "@/lib/sso-policy-actions"
import { toastDone, toastFailure } from "@/lib/toast"
import type { IpAllowlist, SsoAbilities } from "@/lib/sso-types"
import { Loading, ToggleRow, useRemote, useSsoAttempt } from "./shared"

/**
 * The workspace's IP allowlist (#345): two switches (the console, API keys)
 * and the ranges they share. Anyone with `sso:manage` reads it; saving is an
 * owner's, with step-up.
 *
 * ⚠ A LIST THAT LEAVES OUT THE SAVER'S OWN ADDRESS IS REFUSED FIRST. The API
 * answers 422 `would_lock_out`; this asks, naming the address, and only a
 * yes resends with `confirmLockout`. Even then the address keeps access for
 * ten minutes, so the same person can undo it.
 */
export function IpAllowlistPanel({ abilities }: { abilities: SsoAbilities }) {
  const { data, reload, failed } = useRemote(ipAllowlist)
  if (!data) return <Loading failed={failed} />
  return (
    <Form
      key={`${data.console}:${data.apiKeys}:${data.ranges.join(",")}`}
      list={data}
      abilities={abilities}
      reload={reload}
    />
  )
}

function Form({
  list,
  abilities,
  reload,
}: {
  list: IpAllowlist
  abilities: SsoAbilities
  reload: () => Promise<void>
}) {
  const attempt = useSsoAttempt()
  const [console_, setConsole] = React.useState(list.console)
  const [apiKeys, setApiKeys] = React.useState(list.apiKeys)
  const [text, setText] = React.useState(rangesToText(list.ranges))
  const [busy, setBusy] = React.useState(false)
  const [lockout, setLockout] = React.useState<string | null | false>(false)

  const ranges = parseRanges(text)
  const tooMany = ranges.length > list.maxRanges
  const empty = (console_ || apiKeys) && ranges.length === 0
  const changed =
    console_ !== list.console ||
    apiKeys !== list.apiKeys ||
    !sameRanges(ranges, list.ranges)
  const [openedAt] = React.useState(() => Date.now())
  const grace =
    list.graceUntil && new Date(list.graceUntil).getTime() > openedAt
      ? list.graceUntil
      : null

  /** Sends the list; true when it was saved. */
  async function send(confirmLockout: boolean): Promise<boolean> {
    const result = await attempt(() =>
      saveIpAllowlist({
        console: console_,
        apiKeys,
        ranges,
        ...(confirmLockout ? { confirmLockout: true } : {}),
      }),
    )
    if (!result) return false
    if (result.ok) {
      toastDone("IP allowlist saved")
      await reload()
      return true
    }
    if (result.name === "would_lock_out" && !confirmLockout) {
      const named = result.body?.yourAddress
      setLockout(typeof named === "string" ? named : null)
      return false
    }
    toastFailure(result, { title: "Could not save the allowlist" })
    return false
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        {list.yourAddress ? (
          <>
            Your address is <span className="font-mono">{list.yourAddress}</span>.{" "}
            {list.yourAddressListed
              ? "It is on the list."
              : "It is not on the list, so with the console switch on you would be blocked."}
          </>
        ) : (
          "We could not tell your address, so it counts as not listed."
        )}
      </p>
      {grace && (
        <p className="text-sm text-muted-foreground">
          You keep access from your address until <Time iso={grace} mode="exact" />,
          even though it is not on the list.
        </p>
      )}
      <ToggleRow
        label="Limit the console"
        description="Only the listed addresses can open the console and use its API."
        checked={console_}
        disabled={!abilities.owner}
        onChange={setConsole}
      />
      <ToggleRow
        label="Limit API keys"
        description="Requests that use an API key are refused from any address not on the list."
        checked={apiKeys}
        disabled={!abilities.owner}
        onChange={setApiKeys}
      />
      <FloatingTextarea
        label="Allowed addresses and ranges"
        rows={6}
        value={text}
        disabled={!abilities.owner}
        state={tooMany || empty ? "invalid" : "idle"}
        hint={
          tooMany
            ? `At most ${list.maxRanges} entries.`
            : empty
              ? "Add at least one entry before turning a switch on."
              : `One per line, IPv4 or IPv6, with an optional /length. ${ranges.length} of ${list.maxRanges}.`
        }
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          loading={busy}
          disabled={!abilities.owner || !changed || tooMany || empty}
          onClick={async () => {
            setBusy(true)
            try {
              await send(false)
            } finally {
              setBusy(false)
            }
          }}
        >
          Save allowlist
        </Button>
        {!abilities.owner && (
          <p className="text-xs text-muted-foreground">
            Only an owner can change this. Ask an owner.
          </p>
        )}
      </div>
      <ConfirmDialog
        open={lockout !== false}
        onOpenChange={(open) => !open && setLockout(false)}
        title="This list would lock you out"
        description={
          lockout
            ? `Your address, ${lockout}, is not on this list. If you save it anyway you keep access from ${lockout} for 10 minutes, then you are blocked until you connect from a listed address.`
            : // No grace without an address: the API keeps access only for one it knows.
              "We could not tell your address, so we cannot keep it working for you. If you save this list, you are blocked right away until you connect from a listed address."
        }
        confirmLabel="Save anyway"
        doneLabel="Saved"
        onConfirm={() => send(true)}
      />
    </div>
  )
}
