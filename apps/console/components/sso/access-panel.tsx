"use client"

import * as React from "react"
import Link from "next/link"
import { Button } from "@repo/ui/components/button/button"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Time } from "@/components/time"
import { teamAccessDomains, type AccessDomain } from "@/lib/actions"
import {
  addBypass,
  addSsoDomain,
  approveRelink,
  bypassList,
  changeGroupRule,
  changeSsoConnection,
  createGroupRule,
  deleteGroupRule,
  groupRules,
  rejectRelink,
  relinkRequests,
  removeBypass,
  removeSsoDomain,
  ssoTestRuns,
  ssoConnections,
  type ConnectionChange,
} from "@/lib/sso-actions"
import { domainChoices } from "@/lib/sso-domain-choices"
import { latestPass, mfaCapabilityNote } from "@/lib/sso-runs"
import { toastDone, toastFailure } from "@/lib/toast"
import type { SsoAbilities, SsoConnection, SsoEnforcement } from "@/lib/sso-types"
import {
  Block,
  ENFORCEMENT_HELP,
  ENFORCEMENT_LABEL,
  Loading,
  OwnerNote,
  ToggleRow,
  isLocked,
  useRemote,
  useSsoAttempt,
  useSsoCall,
} from "./shared"
import { ClerkMembers, type Member } from "./members"

/**
 * Who may sign in through the connection, and how it is held to account:
 * enforcement, JIT, MFA, session limits, domains, group-to-role rules and the
 * bypass list. Every write goes through step-up (`useSsoCall`); what is an
 * owner's on a live connection is disabled for an admin, with the reason.
 */

const HOUR = 3600
const MAX_SESSION: { value: string; label: string }[] = [
  { value: "none", label: "No limit" },
  { value: String(8 * HOUR), label: "8 hours" },
  { value: String(12 * HOUR), label: "12 hours" },
  { value: String(24 * HOUR), label: "24 hours" },
  { value: String(7 * 24 * HOUR), label: "7 days" },
  { value: String(30 * 24 * HOUR), label: "30 days" },
]
const IDLE: { value: string; label: string }[] = [
  { value: "none", label: "No limit" },
  { value: String(15 * 60), label: "15 minutes" },
  { value: String(HOUR), label: "1 hour" },
  { value: String(8 * HOUR), label: "8 hours" },
  { value: String(24 * HOUR), label: "24 hours" },
]

/** Keeps a stored value that is not on the menu selectable, so it is never silently replaced. */
function withCurrent(
  options: { value: string; label: string }[],
  seconds: number | null,
) {
  if (seconds === null || options.some((o) => o.value === String(seconds)))
    return options
  return [
    ...options,
    { value: String(seconds), label: `${Math.round(seconds / 60)} minutes` },
  ]
}

export function AccessPanel({
  connection,
  abilities,
  clerkEnabled,
  onChange,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  clerkEnabled: boolean
  onChange: (connection: SsoConnection) => void
}) {
  return (
    <>
      <Enforcement connection={connection} abilities={abilities} onChange={onChange} />
      <SignInRules connection={connection} abilities={abilities} onChange={onChange} />
      <Domains connection={connection} abilities={abilities} onChange={onChange} />
      <LoginChanges connection={connection} abilities={abilities} onChange={onChange} />
      <GroupRules connection={connection} abilities={abilities} />
      <Bypass
        connection={connection}
        abilities={abilities}
        clerkEnabled={clerkEnabled}
      />
    </>
  )
}

// ── Enforcement ─────────────────────────────────────────────────────────────

function Enforcement({
  connection,
  abilities,
  onChange,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  onChange: (connection: SsoConnection) => void
}) {
  const call = useSsoCall()
  const [pending, setPending] = React.useState<SsoEnforcement | null>(null)
  const [refusal, setRefusal] = React.useState<string | null>(null)
  const [passedAt, setPassedAt] = React.useState<string | null | undefined>(undefined)
  const live = connection.status === "active" || connection.status === "disabled"
  // Setting a required mode, or loosening a live connection, is an owner's move.
  const ownerOnly = live && !abilities.owner

  async function apply(mode: SsoEnforcement): Promise<boolean> {
    setRefusal(null)
    const result = await call(
      () => changeSsoConnection(connection.id, { enforcement: mode }),
      {
        title: "Could not change enforcement",
      },
    )
    if (result) {
      onChange({ ...connection, ...result, domains: connection.domains })
      toastDone(`Enforcement: ${ENFORCEMENT_LABEL[mode]}`)
      return true
    }
    return false
  }

  async function choose(mode: SsoEnforcement) {
    if (mode === connection.enforcement) return
    if (mode === "required_domain" || mode === "required_all") {
      setPassedAt(undefined)
      setRefusal(null)
      setPending(mode)
      const runs = await ssoTestRuns(connection.id)
      const pass = runs.ok ? latestPass(runs.data.data, Date.now()) : null
      setPassedAt(pass ? pass.createdAt : null)
      return
    }
    await apply(mode)
  }

  return (
    <Block
      title="Enforcement"
      description="Whether people at this connection's domains may, or must, sign in through it."
    >
      <MorphSelect
        label="Enforcement"
        value={connection.enforcement}
        disabled={ownerOnly && connection.enforcement !== "off"}
        onValueChange={(v) => void choose(v as SsoEnforcement)}
        items={(Object.keys(ENFORCEMENT_LABEL) as SsoEnforcement[]).map((m) => ({
          value: m,
          label: ENFORCEMENT_LABEL[m],
          disabled: ownerOnly && (m === "required_domain" || m === "required_all"),
        }))}
        panelWidth={320}
      />
      <p className="text-sm text-muted-foreground">
        {ENFORCEMENT_HELP[connection.enforcement]}
      </p>
      {ownerOnly && (
        <p className="text-xs text-muted-foreground">
          {connection.status === "active" || connection.status === "disabled"
            ? "Only an owner can make a live connection required, or loosen it."
            : ""}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Owners and admins who are not managed by SSO are never forced through it; they
        keep signing in with a passkey. See the owner exemption on the Security page.
      </p>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={
          pending === "required_all"
            ? "Require SSO for everyone?"
            : "Require SSO for the domain?"
        }
        description="Requiring SSO locks every covered member out of every other way into this workspace. Make sure the test below passed first."
        confirmLabel="Require SSO"
        doneLabel="Required"
        destructive={false}
        ready={passedAt !== undefined}
        onConfirm={async () => {
          if (!pending) return false
          const result = await call(
            () => changeSsoConnection(connection.id, { enforcement: pending }),
            { title: "Could not require SSO" },
          )
          if (!result) {
            setRefusal(
              passedAt === null
                ? "Run a test sign-in that passes first. Requiring SSO needs a passed test run in the last 24 hours."
                : "The change was refused. See the message that just appeared.",
            )
            return false
          }
          onChange({ ...connection, ...result, domains: connection.domains })
          return true
        }}
      >
        <div className="space-y-2 text-sm">
          <p className={passedAt ? "text-foreground" : "text-muted-foreground"}>
            {passedAt === undefined
              ? "Checking your test runs…"
              : passedAt
                ? "A test passed in the last 24 hours."
                : "No test has passed in the last 24 hours. The API will refuse until one does."}
          </p>
          <p className="text-muted-foreground">
            A passed test is good for 24 hours. It must be from the last day when you
            press the button, even if the connection was already tested.
          </p>
          {refusal && <p className="text-destructive">{refusal}</p>}
        </div>
      </ConfirmDialog>
    </Block>
  )
}

// ── JIT, MFA, session limits ────────────────────────────────────────────────

function SignInRules({
  connection,
  abilities,
  onChange,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  onChange: (connection: SsoConnection) => void
}) {
  const call = useSsoCall()
  const locked = isLocked(connection, abilities)
  const live = connection.status === "active" || connection.status === "disabled"
  const caps = connection.capabilities
  const mfaBlocked = caps?.canProveMfa === "no"
  const mfaNote = mfaCapabilityNote(connection)

  async function patch(change: ConnectionChange, done: string) {
    const result = await call(() => changeSsoConnection(connection.id, change), {
      title: "Could not save that",
    })
    if (result) {
      onChange({ ...connection, ...result, domains: connection.domains })
      toastDone(done)
    }
  }

  return (
    <Block title="Sign-in rules">
      <ToggleRow
        label="Create accounts at first sign-in (JIT)"
        description="Anyone your provider names at this connection's domains becomes a member the first time they sign in, with the role the group rules give. Off, they need an account already, or one from your directory."
        checked={connection.jitEnabled}
        disabled={locked && !connection.jitEnabled}
        onChange={(v) => void patch({ jitEnabled: v }, v ? "JIT on" : "JIT off")}
      />
      <div className="space-y-1.5">
        <ToggleRow
          label="Require MFA at your provider"
          description="Refuse a sign-in your provider did not prove with a second factor."
          checked={connection.mfaRequired}
          disabled={
            (live && !abilities.owner && connection.mfaRequired) ||
            (mfaBlocked && !connection.mfaRequired)
          }
          onChange={(v) =>
            void patch(
              { mfaRequired: v },
              v ? "MFA required" : "MFA no longer required",
            )
          }
        />
        {mfaNote && (
          <p
            className={
              mfaNote.tone === "warning"
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {mfaNote.text}
          </p>
        )}
        {caps?.canProveFreshAuth === "with_setting" && caps.freshAuthSetting && (
          <p className="text-xs text-muted-foreground">
            For step-up re-verification: {caps.freshAuthSetting}
          </p>
        )}
        {caps?.canProveFreshAuth === "no" && (
          <p className="text-xs text-muted-foreground">
            {caps.label} cannot prove a fresh sign-in, so step-up prompts use i10&apos;s
            own verification.
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <MorphSelect
          label="Longest session"
          value={
            connection.maxSessionSeconds === null
              ? "none"
              : String(connection.maxSessionSeconds)
          }
          onValueChange={(v) =>
            void patch(
              { maxSessionSeconds: v === "none" ? null : Number(v) },
              "Session length saved",
            )
          }
          items={withCurrent(MAX_SESSION, connection.maxSessionSeconds)}
        />
        <MorphSelect
          label="Sign out when idle for"
          value={
            connection.idleTimeoutSeconds === null
              ? "none"
              : String(connection.idleTimeoutSeconds)
          }
          onValueChange={(v) =>
            void patch(
              { idleTimeoutSeconds: v === "none" ? null : Number(v) },
              "Idle timeout saved",
            )
          }
          items={withCurrent(IDLE, connection.idleTimeoutSeconds)}
        />
      </div>
      {connection.provider === "entra" && (
        <p className="text-xs text-muted-foreground">
          Signing out of Microsoft does not sign people out of i10. Sessions end at the
          longest session limit, or when your directory deactivates someone.
        </p>
      )}
      <OwnerNote abilities={abilities} />
    </Block>
  )
}

// ── Changed provider logins ─────────────────────────────────────────────────

const RELINK_HELP: Record<SsoConnection["relink"], string> = {
  ask: "Someone whose provider login changed (a renamed username or email, a recreated app) is refused until an owner approves the new one below.",
  auto: "When a provider login changes, i10 moves the person to the new one if their email is verified, on a domain above, and is the address on their account. It is recorded in the audit log.",
}

function LoginChanges({
  connection,
  abilities,
  onChange,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  onChange: (connection: SsoConnection) => void
}) {
  const call = useSsoCall()
  const { data, setData, failed } = useRemote(() => relinkRequests(connection.id))
  const entra = connection.provider === "entra"

  async function patch(change: ConnectionChange, done: string) {
    const result = await call(() => changeSsoConnection(connection.id, change), {
      title: "Could not save that",
    })
    if (result) {
      onChange({ ...connection, ...result, domains: connection.domains })
      toastDone(done)
    }
  }

  async function decide(requestId: string, approve: boolean) {
    const ok = await call(
      () =>
        approve
          ? approveRelink(connection.id, requestId)
          : rejectRelink(connection.id, requestId),
      { title: approve ? "Could not approve that" : "Could not reject that" },
    )
    if (ok && data) {
      setData({ data: data.data.filter((r) => r.id !== requestId) })
      toastDone(approve ? "Login relinked" : "Request rejected")
    }
  }

  return (
    <Block
      title="Changed logins"
      description="What happens when your provider sends a new login for someone who is already linked."
    >
      <MorphSelect
        label="When a login changes"
        value={connection.relink}
        disabled={!abilities.owner}
        onValueChange={(v) =>
          void patch({ relink: v as SsoConnection["relink"] }, "Saved")
        }
        items={[
          { value: "ask", label: "Ask an owner" },
          { value: "auto", label: "Relink automatically" },
        ]}
      />
      <p className="text-sm text-muted-foreground">{RELINK_HELP[connection.relink]}</p>
      {entra && (
        <ToggleRow
          label="Use the user principal name as the email when Entra sends none"
          description="Entra sends no email for members whose mail field is empty. Off, they are refused. On, their user principal name is used, but only on a domain above. Guest accounts never count."
          checked={connection.upnAsEmail}
          disabled={!abilities.owner}
          onChange={(v) =>
            void patch({ upnAsEmail: v }, v ? "Using the principal name" : "Saved")
          }
        />
      )}
      {!abilities.owner && (
        <p className="text-xs text-muted-foreground">
          Only an owner can change these settings or approve a login.
        </p>
      )}
      {!data ? (
        <Loading failed={failed} />
      ) : data.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No logins are waiting for approval.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {data.data.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{r.email ?? r.clerkUserId}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  Asked <Time iso={r.createdAt} />, expires <Time iso={r.expiresAt} />
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={!abilities.owner}
                onClick={() => void decide(r.id, false)}
              >
                Reject
              </Button>
              <Button
                size="sm"
                disabled={!abilities.owner}
                onClick={() => void decide(r.id, true)}
              >
                Approve
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Block>
  )
}

// ── Domains ─────────────────────────────────────────────────────────────────

function Domains({
  connection,
  abilities,
  onChange,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  onChange: (connection: SsoConnection) => void
}) {
  const call = useSsoCall()
  const attempt = useSsoAttempt()
  const locked = isLocked(connection, abilities)
  const [options, setOptions] = React.useState<AccessDomain[] | null>(null)
  const [connections, setConnections] = React.useState<SsoConnection[]>([])
  const [choice, setChoice] = React.useState<string | null>(null)
  const [refusal, setRefusal] = React.useState<string | null>(null)

  React.useEffect(() => {
    void Promise.all([teamAccessDomains(), ssoConnections()]).then(
      ([domainsResult, connectionsResult]) => {
        setOptions(
          domainsResult.ok
            ? domainsResult.data.data.filter((d) => d.status === "verified")
            : [],
        )
        setConnections(connectionsResult.ok ? connectionsResult.data.data : [])
      },
    )
  }, [])

  const choices = domainChoices(options ?? [], connections, connection)

  async function add() {
    if (!choice) return
    setRefusal(null)
    const domain = choices.find((d) => d.id === choice && !d.coveredBy)
    const result = await attempt(() => addSsoDomain(connection.id, choice))
    if (result === null) return
    if (!result.ok) {
      toastFailure(result, { title: "Could not add the domain" })
      setRefusal(result.error)
      if (result.status === 409) {
        const latest = await ssoConnections()
        if (latest.ok) setConnections(latest.data.data)
        setChoice(null)
      }
      return
    }
    if (domain) {
      onChange({
        ...connection,
        domains: [
          ...connection.domains,
          { joinDomainId: domain.id, name: domain.name, live: true },
        ],
      })
      setChoice(null)
      toastDone(`${domain.name} added`)
    }
  }

  async function remove(joinDomainId: string, name: string) {
    const ok = await call(() => removeSsoDomain(connection.id, joinDomainId), {
      title: "Could not remove the domain",
    })
    if (ok) {
      onChange({
        ...connection,
        domains: connection.domains.filter((d) => d.joinDomainId !== joinDomainId),
      })
      toastDone(`${name} removed`)
    }
  }

  return (
    <Block
      title="Domains"
      description="Only addresses on these verified domains can sign in through this connection."
    >
      {connection.domains.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No domain yet. A connection cannot go live without one.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {connection.domains.map((d) => (
            <li
              key={d.joinDomainId}
              className="flex items-center gap-3 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              {!d.live && (
                <span className="text-xs text-muted-foreground">
                  Not verified right now
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={locked}
                onClick={() => void remove(d.joinDomainId, d.name)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {choices.length > 0 && (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <MorphSelect
              label="Add a verified domain"
              value={choice}
              disabled={locked}
              onValueChange={(value) => {
                setChoice(value)
                setRefusal(null)
              }}
              items={choices.map((d) => ({
                value: d.id,
                label: d.coveredBy
                  ? `${d.name} (covered by ${d.coveredBy.name})`
                  : d.name,
                disabled: d.coveredBy !== null,
              }))}
            />
          </div>
          <Button variant="secondary" disabled={locked || !choice} onClick={add}>
            Add
          </Button>
        </div>
      )}
      {choices.some((d) => d.coveredBy) && (
        <p className="text-xs text-muted-foreground">
          A domain belongs to one connection. To move one here, remove it from the other
          connection first.
        </p>
      )}
      {refusal && <p className="text-xs text-destructive">{refusal}</p>}
      <p className="text-xs text-muted-foreground">
        Need another domain? Prove it on the{" "}
        <Link
          href="/settings/team"
          className="text-foreground underline underline-offset-4"
        >
          Team page
        </Link>
        , then add it here.
      </p>
      <OwnerNote abilities={abilities} />
    </Block>
  )
}

// ── Group rules ─────────────────────────────────────────────────────────────

const RULE_ROLES = [
  { value: "member", label: "Member" },
  { value: "admin", label: "Admin" },
]

function GroupRules({
  connection,
  abilities,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
}) {
  const call = useSsoCall()
  const { data, setData, failed } = useRemote(() => groupRules(connection.id))
  const locked = isLocked(connection, abilities)
  const [group, setGroup] = React.useState("")
  const [role, setRole] = React.useState<"member" | "admin">("member")

  const rules = data?.data ?? []
  const nextPrecedence = rules.length
    ? Math.max(...rules.map((r) => r.precedence)) + 10
    : 10

  async function add() {
    const made = await call(
      () =>
        createGroupRule(connection.id, {
          group: group.trim(),
          role,
          precedence: nextPrecedence,
        }),
      { title: "Could not add the rule" },
    )
    if (made && data) {
      setData({
        ...data,
        data: [...data.data, made].sort((a, b) => a.precedence - b.precedence),
      })
      setGroup("")
      toastDone("Rule added")
    }
  }

  return (
    <Block
      title="Group rules"
      description="Roles from your provider's groups, read at every sign-in. The first matching rule by precedence wins; no match gives the default, member. Owners are never made this way."
    >
      {!data ? (
        <Loading failed={failed} />
      ) : (
        <>
          {rules.length > 0 && (
            <ul className="divide-y rounded-lg border">
              {rules.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="w-8 text-xs text-muted-foreground">
                    {r.precedence}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {r.group}
                  </span>
                  <div className="w-32">
                    <MorphSelect
                      label="Role"
                      hideLabel
                      value={r.role}
                      disabled={locked}
                      onValueChange={async (v) => {
                        const after = await call(
                          () =>
                            changeGroupRule(connection.id, r.id, {
                              role: v as "member" | "admin",
                            }),
                          { title: "Could not change the rule" },
                        )
                        if (after)
                          setData({
                            ...data,
                            data: data.data.map((x) => (x.id === r.id ? after : x)),
                          })
                      }}
                      items={RULE_ROLES}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    onClick={async () => {
                      const ok = await call(
                        () => deleteGroupRule(connection.id, r.id),
                        {
                          title: "Could not delete the rule",
                        },
                      )
                      if (ok)
                        setData({
                          ...data,
                          data: data.data.filter((x) => x.id !== r.id),
                        })
                    }}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {rules.length < data.max && (
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <FloatingInput
                  label="Group name or id"
                  value={group}
                  disabled={locked}
                  maxLength={256}
                  onChange={(e) => setGroup(e.target.value)}
                />
              </div>
              <div className="w-32">
                <MorphSelect
                  label="Role"
                  value={role}
                  disabled={locked}
                  onValueChange={(v) => setRole(v as "member" | "admin")}
                  items={RULE_ROLES}
                />
              </div>
              <Button
                variant="secondary"
                disabled={locked || !group.trim()}
                onClick={add}
              >
                Add rule
              </Button>
            </div>
          )}
          <OwnerNote abilities={abilities} />
        </>
      )}
    </Block>
  )
}

// ── Bypass list ─────────────────────────────────────────────────────────────

function Bypass({
  connection,
  abilities,
  clerkEnabled,
}: {
  connection: SsoConnection
  abilities: SsoAbilities
  clerkEnabled: boolean
}) {
  const call = useSsoCall()
  const { data, setData, failed } = useRemote(() => bypassList(connection.id))
  const locked = isLocked(connection, abilities)
  const [members, setMembers] = React.useState<Member[] | null>(null)
  const [userId, setUserId] = React.useState("")
  const [reason, setReason] = React.useState("")
  const label = (id: string) => members?.find((m) => m.userId === id)?.label ?? id

  async function add() {
    const made = await call(
      () => addBypass(connection.id, userId.trim(), reason.trim()),
      {
        title: "Could not add them to the list",
      },
    )
    if (made && data) {
      setUserId("")
      setReason("")
      toastDone("Added to the bypass list")
      const fresh = await bypassList(connection.id)
      if (fresh.ok) setData(fresh.data)
    }
  }

  return (
    <Block
      title="Bypass list"
      description="People who may skip this connection when it is required, for when your provider is down. Every use is audited. Keep it short."
    >
      {clerkEnabled && <ClerkMembers onMembers={setMembers} />}
      {!data ? (
        <Loading failed={failed} />
      ) : (
        <>
          {data.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody is on the list.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {data.data.map((entry) => (
                <li
                  key={entry.userId}
                  className="flex items-center gap-3 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{label(entry.userId)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {entry.reason} &middot; <Time iso={entry.createdAt} />
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked}
                    onClick={async () => {
                      const ok = await call(
                        () => removeBypass(connection.id, entry.userId),
                        {
                          title: "Could not remove them",
                        },
                      )
                      if (ok)
                        setData({
                          data: data.data.filter((e) => e.userId !== entry.userId),
                        })
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {members && members.length > 0 ? (
              <MorphSelect
                label="Member"
                value={userId || null}
                disabled={locked}
                onValueChange={setUserId}
                items={members.map((m) => ({ value: m.userId, label: m.label }))}
              />
            ) : (
              <FloatingInput
                label="Member's user id"
                hint="Starts with user_"
                value={userId}
                disabled={locked}
                onChange={(e) => setUserId(e.target.value)}
              />
            )}
            <FloatingInput
              label="Why"
              value={reason}
              disabled={locked}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={locked || !userId.trim() || !reason.trim()}
            onClick={add}
          >
            Add to the list
          </Button>
          <OwnerNote abilities={abilities} />
        </>
      )}
    </Block>
  )
}
