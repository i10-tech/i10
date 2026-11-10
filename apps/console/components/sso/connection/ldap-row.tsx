"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Switch } from "@repo/ui/components/i10/switch"
import { Textarea } from "@repo/ui/components/i10/textarea"
import { Time } from "@/components/time"
import { ldapSetup, saveLdap, testLdap } from "@/lib/sso-actions"
import { toastDone, toastError } from "@/lib/toast"
import type {
  LdapSetup,
  LdapTestOutcome,
  SsoAbilities,
  SsoConnection,
} from "@/lib/sso-types"
import { SettingsGroup, SettingsRow } from "../settings-card"
import { isLocked, OwnerNote, useSsoCall } from "../shared"
import { LdapServiceAccount } from "./ldap-service-account"

const TEST_RESULT: Record<LdapTestOutcome["result"], string> = {
  ok: "Everything worked.",
  unreachable: "We could not reach the server. Check the host and port.",
  tls_failed: "We reached the server but could not trust its certificate.",
  service_bind_failed: "The service account was refused. Check its DN and secret.",
  user_not_found:
    "The service account worked, but the filter found nobody with that address.",
  user_bind_failed: "The person was found, but their password was refused.",
}

/**
 * The body of the LDAP lane of "Mail sign-in" (mail-sign-in.tsx), which owns
 * the data and the choice of lane. It was the body of an Advanced row; nothing
 * about what it does changed when it moved.
 */
export function LdapContent({
  connection,
  abilities,
  data,
  setData,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  data: LdapSetup
  setData: (next: LdapSetup) => void
}) {
  const call = useSsoCall()
  const locked = isLocked(connection, abilities)
  const [form, setForm] = React.useState({
    host: data.host ?? "",
    port: String(data.port ?? data.ports[1] ?? 636),
    tlsMode: (data.tlsMode ?? "ldaps") as string,
    caPem: data.caPem ?? "",
    searchBase: data.searchBase ?? "",
    userFilter: data.userFilter ?? "",
  })
  const [address, setAddress] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [outcome, setOutcome] = React.useState<LdapTestOutcome | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  async function save() {
    setBusy("settings")
    try {
      const after = await call(
        () =>
          saveLdap(connection.id, {
            host: form.host.trim(),
            port: Number(form.port),
            tlsMode: form.tlsMode as "ldaps" | "starttls",
            caPem: form.caPem.trim() || null,
            searchBase: form.searchBase.trim(),
            userFilter: form.userFilter.trim(),
          }),
        { title: "Could not save the settings" },
      )
      if (after) {
        setData(after)
        setOutcome(null)
        toastDone("Settings saved")
      }
    } finally {
      setBusy(null)
    }
  }

  async function runTest() {
    setBusy("test")
    try {
      const result = await call(
        () => testLdap(connection.id, address.trim(), password || undefined),
        { title: "The test could not run" },
      )
      setPassword("")
      if (!result) return
      setOutcome(result)
      if (result.result === "ok") {
        const fresh = await ldapSetup(connection.id)
        if (fresh.ok) setData(fresh.data)
      } else toastError("The test did not pass", TEST_RESULT[result.result])
    } finally {
      setBusy(null)
    }
  }

  async function toggle(enabled: boolean) {
    const after = await call(() => saveLdap(connection.id, { enabled }), {
      title: enabled ? "Could not turn it on" : "Could not turn it off",
    })
    if (after) {
      setData(after)
      toastDone(enabled ? "Pass-through on" : "Pass-through off")
    }
  }

  return (
    <div className="space-y-6 pt-2">
      <SettingsGroup>
        <SettingsRow
          title="Ask this directory for passwords"
          description="Needs a passing test on the current settings from the last 24 hours."
          action={
            <Switch
              checked={data.enabled}
              disabled={(locked && !data.enabled) || (!data.enabled && !data.tested)}
              onCheckedChange={(v) => void toggle(v)}
              aria-label="Ask this directory for passwords"
            />
          }
        />
      </SettingsGroup>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Directory settings</h4>
        <SettingsGroup>
          <div className="p-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <FloatingInput
                label="Host"
                value={form.host}
                disabled={locked}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
              />
              <MorphSelect
                label="Port"
                value={form.port}
                disabled={locked}
                onValueChange={(v) => setForm({ ...form, port: v })}
                items={data.ports.map((p) => ({ value: String(p), label: String(p) }))}
              />
            </div>
            <MorphSelect
              label="Encryption"
              value={form.tlsMode}
              disabled={locked}
              onValueChange={(v) => setForm({ ...form, tlsMode: v })}
              items={data.tlsModes.map((m) => ({
                value: m,
                label: m === "ldaps" ? "LDAPS (TLS from start)" : "STARTTLS",
              }))}
            />
            <FloatingInput
              label="Search base"
              hint="For example ou=people,dc=example,dc=com"
              value={form.searchBase}
              disabled={locked}
              onChange={(e) => setForm({ ...form, searchBase: e.target.value })}
            />
            <FloatingInput
              label="User filter"
              hint={`Use ${data.filterPlaceholder} where the address goes`}
              value={form.userFilter}
              disabled={locked}
              onChange={(e) => setForm({ ...form, userFilter: e.target.value })}
            />
            <Textarea
              placeholder="Your directory's CA certificate (PEM, optional)"
              rows={3}
              value={form.caPem}
              disabled={locked}
              onChange={(e) => setForm({ ...form, caPem: e.target.value })}
            />
            <div className="flex items-center gap-3">
              <Button onClick={save} loading={busy === "settings"} disabled={locked}>
                Save settings
              </Button>
              <OwnerNote abilities={abilities} />
            </div>
          </div>
        </SettingsGroup>
      </div>

      <LdapServiceAccount
        connection={connection}
        data={data}
        setData={setData}
        locked={locked}
        onAccountSaved={() => setOutcome(null)}
      />

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Test directory</h4>
        <SettingsGroup>
          <div className="p-4 space-y-4">
            <FloatingInput
              label="An address to look up"
              type="email"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <FloatingInput
              label="Their password (optional)"
              type="password"
              autoComplete="off"
              hint="Used for this one request and kept nowhere."
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button
              variant="secondary"
              onClick={runTest}
              loading={busy === "test"}
              disabled={!address.trim()}
            >
              Run the test
            </Button>
            {outcome && (
              <p
                className={
                  outcome.result === "ok" ? "text-sm" : "text-sm text-destructive"
                }
              >
                {TEST_RESULT[outcome.result]}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {data.tested && data.testedAt ? (
                <>
                  A test passed <Time iso={data.testedAt} /> on these settings.
                </>
              ) : (
                "No passing test on the current settings."
              )}
            </p>
          </div>
        </SettingsGroup>
      </div>
    </div>
  )
}
