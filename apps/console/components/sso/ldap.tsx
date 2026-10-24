"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { Textarea } from "@repo/ui/components/i10/textarea"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { Time } from "@/components/time"
import { ldapSetup, saveLdap, saveLdapService, testLdap } from "@/lib/sso-actions"
import { toastDone, toastError } from "@/lib/toast"
import type {
  LdapSetup,
  LdapTestOutcome,
  SsoAbilities,
  SsoConnection,
} from "@/lib/sso-types"
import {
  Block,
  Loading,
  OwnerNote,
  ToggleRow,
  isLocked,
  useRemote,
  useSsoCall,
} from "./shared"

/**
 * LDAP pass-through (sso.md 2.8): where i10 asks the company's own directory
 * whether a managed person's password is right, for their mail client, instead
 * of asking Clerk. It is only ever turned on for settings a test passed on.
 *
 * ⚠ THE SERVICE ACCOUNT'S SECRET AND THE TEST PASSWORD ARE WRITE-ONLY. Both
 * are cleared from the page the moment they are sent, and no answer carries
 * them back.
 */

const TEST_RESULT: Record<LdapTestOutcome["result"], string> = {
  ok: "Everything worked.",
  unreachable: "We could not reach the server. Check the host and port.",
  tls_failed:
    "We reached the server but could not trust its certificate. Check the TLS mode, or paste your CA certificate.",
  service_bind_failed: "The service account was refused. Check its DN and secret.",
  user_not_found:
    "The service account worked, but the filter found nobody with that address.",
  user_bind_failed: "The person was found, but their password was refused.",
}

export function LdapPanel(props: {
  connection: SsoConnection
  abilities: SsoAbilities
}) {
  const { data, setData, failed } = useRemote(() => ldapSetup(props.connection.id))
  if (!data) return <Loading failed={failed} />
  return <LdapForm {...props} data={data} setData={setData} />
}

function LdapForm({
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
  const [bindDn, setBindDn] = React.useState("")
  const [bindSecret, setBindSecret] = React.useState("")
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
        toastDone(
          "Settings saved",
          data.enabled
            ? "Pass-through was turned off. Test again to turn it back on."
            : undefined,
        )
      }
    } finally {
      setBusy(null)
    }
  }

  async function saveService() {
    setBusy("service")
    try {
      const after = await call(
        () => saveLdapService(connection.id, bindDn.trim(), bindSecret),
        {
          title: "Could not save the service account",
        },
      )
      if (after) {
        setData(after)
        setBindDn("")
        setBindSecret("")
        setOutcome(null)
        toastDone("Service account saved")
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
    <>
      <Block
        title="Directory"
        description="Where we ask about the passwords of people this connection manages, when their mail client signs in."
      >
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
            label: m === "ldaps" ? "LDAPS (TLS from the start)" : "STARTTLS",
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
          hint={`Use ${data.filterPlaceholder} where the address goes, for example (mail=${data.filterPlaceholder})`}
          value={form.userFilter}
          disabled={locked}
          onChange={(e) => setForm({ ...form, userFilter: e.target.value })}
        />
        <Textarea
          aria-label="CA certificate (PEM, optional)"
          placeholder="Your directory's CA certificate, if it is not a public one"
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
      </Block>

      <Block
        title="Service account"
        description={
          data.serviceSet
            ? "A service account is saved. It cannot be shown again; enter a new one to replace it. Changing it turns pass-through off."
            : "An account that may search the directory. Its secret is stored encrypted and never shown again."
        }
      >
        <FloatingInput
          label="Bind DN"
          value={bindDn}
          disabled={locked}
          autoComplete="off"
          onChange={(e) => setBindDn(e.target.value)}
        />
        <FloatingInput
          label="Secret"
          type="password"
          autoComplete="off"
          value={bindSecret}
          disabled={locked}
          onChange={(e) => setBindSecret(e.target.value)}
        />
        <Button
          onClick={saveService}
          loading={busy === "service"}
          disabled={locked || !bindDn.trim() || !bindSecret}
        >
          {data.serviceSet ? "Replace service account" : "Save service account"}
        </Button>
      </Block>

      <Block
        title="Test"
        description="Looks the address up with the service account, and optionally checks their password. A pass counts for 24 hours and only for these settings."
      >
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
            className={outcome.result === "ok" ? "text-sm" : "text-sm text-destructive"}
          >
            {TEST_RESULT[outcome.result]}
            {outcome.result === "ok" && !outcome.recorded
              ? " The settings changed while it ran, so this pass was not recorded."
              : ""}
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
      </Block>

      <Block title="Pass-through">
        <ToggleRow
          label="Ask this directory for passwords"
          description="Needs a passing test on the current settings from the last 24 hours."
          checked={data.enabled}
          disabled={(locked && !data.enabled) || (!data.enabled && !data.tested)}
          onChange={(v) => void toggle(v)}
        />
      </Block>
    </>
  )
}
