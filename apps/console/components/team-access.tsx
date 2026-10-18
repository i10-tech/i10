"use client"

import * as React from "react"
import Link from "next/link"
import { AlertTriangle, X } from "lucide-react"
import { Badge } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { DropdownMenuItem } from "@repo/ui/components/i10/menu"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { VerifiedSeal } from "@repo/ui/components/i10/verified-seal"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import {
  AddAction,
  MotionItem,
  MotionList,
  shortDate,
  useFollowOpen,
} from "@/components/account/shared"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { RowMenu } from "@/components/list/row-menu"
import {
  addAccessDomain,
  allowAddress,
  dismissAccessSuggestion,
  removeAccessDomain,
  saveAccessRules,
  teamExclusions,
  verifyAccessDomain,
  type AccessDomain,
  type AccessMode,
  type AccessRule,
  type Exclusion,
} from "@/lib/actions"
import { toastDone, toastError } from "@/lib/toast"

/**
 * Team access (#326): the Team page's access domains and their rules, and
 * the removed and block lists.
 *
 * ⚠ SEPARATE FROM SENDING DOMAINS, AND IT STARTS EMPTY. A domain verified on
 * /domains is offered as a suggestion card - exactly as named, never its
 * parent - and "Add" can pick it later after "Not now". A name that never
 * sends is proved with its own TXT record instead.
 *
 * ⚠ THE API CHECKS EVERYTHING AGAIN. Patterns that reach above the proven
 * name, free-mail domains and non-admins are refused there; this page only
 * words the choices and warns before the two that let people in unasked.
 */

export type AccessState = {
  domains: AccessDomain[]
  verified: string[]
  suggested: string[]
}

const MODES: { value: AccessMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "suggest", label: "Suggest" },
  { value: "auto", label: "Auto-join" },
]

const MODE_HELP: Record<AccessMode, string> = {
  off: "Nothing for new people. Pending requests can still be answered.",
  suggest: "People with a matching address see this workspace and can ask to join.",
  auto: "New sign-ups join straight away; existing users can join with one click.",
}

const at = (pattern: string) => `@${pattern}`

// ── Access domains ───────────────────────────────────────────────────────────

export function AccessDomains({
  state,
  roles,
  onChange,
}: {
  /** `false` when the API could not say. */
  state: AccessState | false | null
  roles: { value: string; label: string }[]
  onChange: () => void
}) {
  const [adding, setAdding] = React.useState(false)

  if (state === null)
    return <p className="pt-1.5 text-sm text-muted-foreground">Loading domains…</p>
  if (state === false)
    return (
      <p className="pt-1.5 text-sm text-muted-foreground">
        Could not load this workspace&rsquo;s access domains. Reload to try again.
      </p>
    )

  const added = new Set(state.domains.map((d) => d.name))

  return (
    <div className="flex flex-col gap-3">
      <Suggestions names={state.suggested} onChange={onChange} />
      {state.domains.length === 0 && !adding && (
        <p className="pt-1.5 text-sm text-muted-foreground">
          Choose who can find and join this workspace by their email address. Add a
          domain you verified on{" "}
          <Link
            href="/domains"
            className="text-foreground underline underline-offset-4"
          >
            Domains
          </Link>
          , or prove one with a TXT record.
        </p>
      )}
      <MotionList>
        {state.domains.map((domain) => (
          <MotionItem key={domain.id}>
            <DomainRow domain={domain} roles={roles} onChange={onChange} />
          </MotionItem>
        ))}
      </MotionList>
      <AddDomain
        open={adding}
        onOpenChange={setAdding}
        verified={state.verified.filter((n) => !added.has(n))}
        onAdded={onChange}
      />
    </div>
  )
}

/**
 * The /domains names not yet used for access, each with "Add" or "Not now".
 * Dismissal is the workspace's, on the server.
 */
function Suggestions({ names, onChange }: { names: string[]; onChange: () => void }) {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [hidden, setHidden] = React.useState<string[]>([])
  const shown = names.filter((n) => !hidden.includes(n))
  if (shown.length === 0) return null

  async function act(name: string, add: boolean) {
    setBusy(name)
    const result = add
      ? await addAccessDomain(name, "domains")
      : await dismissAccessSuggestion(name)
    setBusy(null)
    if (!result.ok) {
      toastError(add ? `Could not add ${name}` : "Could not dismiss that", {
        description: result.error,
      })
      return
    }
    setHidden((list) => [...list, name])
    onChange()
  }

  return (
    <MotionList>
      {shown.map((name) => (
        <MotionItem key={name}>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4">
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-medium">
                <span className="truncate font-mono">{name}</span>
                <VerifiedSeal />
              </span>
              <span className="block text-xs text-muted-foreground">
                Verified on Domains. Use it to let people with an {at(name)} address
                find this workspace?
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy !== null}
                onClick={() => void act(name, false)}
              >
                Not now
              </Button>
              <Button
                size="sm"
                loading={busy === name}
                disabled={busy !== null}
                onClick={() => void act(name, true)}
              >
                Add
              </Button>
            </span>
          </div>
        </MotionItem>
      ))}
    </MotionList>
  )
}

const OTHER = "__txt__"

/** "+ Add domain": one verified on /domains, or any name to prove by TXT. */
function AddDomain({
  open,
  onOpenChange,
  verified,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  verified: string[]
  onAdded: () => void
}) {
  const [choice, setChoice] = React.useState<string | null>(null)
  const [name, setName] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const follow = useFollowOpen<HTMLFormElement>(open)
  const picked = choice ?? verified[0] ?? OTHER
  const items = [
    ...verified.map((n) => ({ value: n, label: n })),
    { value: OTHER, label: "Another domain, proved with a TXT record" },
  ]

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const txt = picked === OTHER
    const target = txt ? name.trim() : picked
    if (!target) return
    setSaving(true)
    setError(null)
    const result = await addAccessDomain(target, txt ? "txt" : "domains")
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    toastDone(txt ? `Add the TXT record to prove ${target}` : `${target} added`)
    setName("")
    setChoice(null)
    onOpenChange(false)
    onAdded()
  }

  return (
    <>
      <Reveal show={open} spacing="pt-1">
        <form
          ref={follow}
          noValidate
          onSubmit={submit}
          className="flex scroll-mb-6 flex-col gap-5 rounded-2xl border p-4"
        >
          <MorphSelect
            label="Domain"
            items={items}
            value={picked}
            onValueChange={(value) => {
              setError(null)
              setChoice(value)
            }}
          />
          {picked === OTHER && (
            <FloatingInput
              label="Domain name"
              id="access-domain-name"
              value={name}
              onChange={(event) => {
                setError(null)
                setName(event.target.value)
              }}
              hint="It covers this name and its subdomains, never its parent."
              maxLength={253}
              disabled={saving}
            />
          )}
          {error && <p className="-mt-2 text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={saving}
              disabled={picked === OTHER && !name.trim()}
            >
              Add domain
            </Button>
          </div>
        </form>
      </Reveal>
      {!open && (
        <div>
          <AddAction onClick={() => onOpenChange(true)}>Add domain</AddAction>
        </div>
      )}
    </>
  )
}

const STATUS: Record<
  AccessDomain["status"],
  { label: string; tone: "success" | "warning" | "danger" | "neutral" }
> = {
  verified: { label: "Verified", tone: "success" },
  pending: { label: "Waiting for TXT record", tone: "neutral" },
  lapsed: { label: "Proof lapsed", tone: "warning" },
  displaced: { label: "Verified by another workspace", tone: "danger" },
}

function DomainRow({
  domain,
  roles,
  onChange,
}: {
  domain: AccessDomain
  roles: { value: string; label: string }[]
  onChange: () => void
}) {
  const [editing, setEditing] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)
  const [checking, setChecking] = React.useState(false)
  const status = STATUS[domain.status]
  const needsTxt = domain.status !== "verified"

  async function verify() {
    setChecking(true)
    const result = await verifyAccessDomain(domain.id)
    setChecking(false)
    if (!result.ok) {
      toastError(`Could not check ${domain.name}`, { description: result.error })
      return
    }
    if (result.data.proven) {
      toastDone(`${domain.name} verified`)
      onChange()
    } else {
      toastError(
        result.data.reason === "unreachable"
          ? "We could not reach its DNS just now"
          : "The TXT record is not there yet",
        {
          description:
            result.data.reason === "unreachable"
              ? "Try again in a minute."
              : "DNS changes can take a few minutes to show. Try again shortly.",
        },
      )
    }
  }

  const summary =
    domain.rules.length === 0
      ? "No rules yet, so nobody new can find this workspace by it."
      : domain.rules
          .map(
            (r) =>
              `${at(r.pattern)}: ${MODES.find((m) => m.value === r.mode)?.label ?? r.mode}`,
          )
          .join(" · ")

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm">
            <span className="truncate font-mono">{domain.name}</span>
            {domain.status === "verified" ? (
              <VerifiedSeal />
            ) : (
              <Badge size="sm" tone={status.tone}>
                {status.label}
              </Badge>
            )}
          </span>
          <span className="block text-xs text-muted-foreground">
            {domain.orphaned
              ? "Its sending domain was deleted. Add this TXT record to keep using it for access."
              : domain.status === "lapsed"
                ? "We could no longer find its proof, so its rules have stopped."
                : domain.status === "displaced"
                  ? "Another workspace proved this name after you did. Verify again to take it back."
                  : summary}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {domain.status === "verified" && (
            <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)}>
              {editing ? "Close" : "Rules"}
            </Button>
          )}
          <RowMenu visible label={domain.name}>
            <DropdownMenuItem
              className="text-danger"
              onSelect={() => setRemoving(true)}
            >
              Remove domain
            </DropdownMenuItem>
          </RowMenu>
        </span>
      </div>

      {needsTxt && (
        <div className="flex flex-col gap-2 rounded-2xl border p-4">
          <p className="text-xs text-muted-foreground">
            Add this TXT record at your DNS provider, then verify. It proves{" "}
            {domain.name} and its subdomains for team access only; nothing is sent from
            it.
          </p>
          <CopyField label="Name" value={domain.txt.name} mono />
          <CopyField label="Value" value={domain.txt.value} mono />
          <div className="flex justify-end">
            <Button size="sm" loading={checking} onClick={() => void verify()}>
              Verify
            </Button>
          </div>
        </div>
      )}

      <Reveal show={editing && domain.status === "verified"} spacing="pt-0">
        <RulesEditor
          domain={domain}
          roles={roles}
          onSaved={() => {
            setEditing(false)
            onChange()
          }}
        />
      </Reveal>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${domain.name}?`}
        description="Its rules stop at once. Nobody already in the workspace is removed, and pending requests stay answerable."
        confirmLabel="Remove"
        doneLabel="Removed"
        onConfirm={async () => {
          const result = await removeAccessDomain(domain.id)
          if (!result.ok) {
            toastError(`Could not remove ${domain.name}`, { description: result.error })
            return false
          }
          onChange()
          return true
        }}
      />
    </div>
  )
}

/**
 * One domain's rules: pattern, mode, role. Most specific pattern wins.
 *
 * ⚠ TWO CHOICES ARE CONFIRMED BEFORE SAVING: switching auto-join on (people
 * get in with nobody approving them) and giving the admin role by rule. Both
 * are allowed; neither should happen by a stray click in a picker.
 */
function RulesEditor({
  domain,
  roles,
  onSaved,
}: {
  domain: AccessDomain
  roles: { value: string; label: string }[]
  onSaved: () => void
}) {
  const fallbackRole =
    roles.find((r) => r.value === "org:member")?.value ?? "org:member"
  const [rules, setRules] = React.useState<AccessRule[]>(() =>
    domain.rules.length > 0
      ? domain.rules
      : [{ pattern: domain.name, mode: "suggest", role: fallbackRole }],
  )
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const roleItems =
    roles.length > 0 ? roles : [{ value: "org:member", label: "Member" }]

  const newlyAuto = rules.some(
    (r) =>
      r.mode === "auto" &&
      !domain.rules.some((o) => o.pattern === r.pattern && o.mode === "auto"),
  )
  const newlyAdmin = rules.some(
    (r) =>
      r.role === "org:admin" &&
      r.mode !== "off" &&
      !domain.rules.some((o) => o.pattern === r.pattern && o.role === "org:admin"),
  )

  function update(index: number, change: Partial<AccessRule>) {
    setError(null)
    setRules((list) => list.map((r, i) => (i === index ? { ...r, ...change } : r)))
  }

  async function save() {
    setSaving(true)
    setError(null)
    const result = await saveAccessRules(
      domain.id,
      rules.map((r) => ({ ...r, pattern: r.pattern.trim().toLowerCase() })),
    )
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return false
    }
    toastDone(`Rules for ${domain.name} saved`)
    onSaved()
    return true
  }

  const warnings = [
    newlyAuto &&
      "Auto-join adds people who sign up with a matching verified address without anyone approving them, and lets existing users with one join in a click.",
    newlyAdmin &&
      "Admins can invite and remove people, change roles, and manage domains and billing.",
  ].filter((w): w is string => Boolean(w))

  return (
    <div className="flex flex-col gap-4 rounded-2xl border p-4">
      <p className="text-xs text-muted-foreground">
        A rule covers an exact name ({domain.name}), a subdomain (dev.{domain.name}), or
        every subdomain at any depth (*.{domain.name}). The most specific rule wins, and
        only verified addresses count.
      </p>
      <MotionList>
        {rules.map((rule, index) => (
          <MotionItem key={index}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <FloatingInput
                label="Addresses at"
                id={`rule-${domain.id}-${index}`}
                value={rule.pattern}
                onChange={(event) => update(index, { pattern: event.target.value })}
                maxLength={253}
                reserveHint={false}
                className="font-mono"
                containerClassName="min-w-0 flex-1"
              />
              <MorphSelect
                label="Mode"
                hideLabel
                items={MODES}
                value={rule.mode}
                onValueChange={(value) => update(index, { mode: value as AccessMode })}
              />
              <MorphSelect
                label="Role"
                hideLabel
                items={roleItems}
                value={rule.role}
                onValueChange={(value) => update(index, { role: value })}
              />
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove the rule for ${rule.pattern || "this pattern"}`}
                onClick={() => setRules((list) => list.filter((_, i) => i !== index))}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </div>
            <p className="pt-1 text-xs text-muted-foreground">{MODE_HELP[rule.mode]}</p>
          </MotionItem>
        ))}
      </MotionList>
      <div>
        <AddAction
          onClick={() =>
            setRules((list) => [
              ...list,
              { pattern: `*.${domain.name}`, mode: "suggest", role: fallbackRole },
            ])
          }
        >
          Add rule
        </AddAction>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end">
        <Button
          size="sm"
          loading={saving && !confirming}
          onClick={() => (warnings.length > 0 ? setConfirming(true) : void save())}
        >
          Save rules
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={newlyAuto ? "Turn on auto-join?" : "Give the admin role by rule?"}
        description={warnings.join(" ")}
        confirmLabel="Save rules"
        doneLabel="Saved"
        destructive={false}
        onConfirm={save}
      >
        <p className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle
            className="mt-0.5 size-3.5 shrink-0 text-warning"
            aria-hidden
          />
          <span>
            Removed people can only ask to join again, and blocked people get nothing.
          </span>
        </p>
      </ConfirmDialog>
    </div>
  )
}

// ── Removed and blocked ──────────────────────────────────────────────────────

/**
 * The removed and block lists, by email address - so deleting an account and
 * signing up again changes nothing. "Allow" takes them off; "Allow and
 * invite" also sends an invitation.
 */
export function Exclusions({ version }: { version: number }) {
  const [list, setList] = React.useState<Exclusion[] | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const load = React.useCallback(() => {
    void teamExclusions().then((result) => setList(result.ok ? result.data.data : []))
  }, [])
  React.useEffect(load, [load, version])

  async function allow(entry: Exclusion, invite: boolean) {
    setBusy(entry.email)
    const result = await allowAddress(entry.email, invite)
    setBusy(null)
    if (!result.ok) {
      toastError(`Could not allow ${entry.email}`, { description: result.error })
      return
    }
    toastDone(invite ? `Invited ${entry.email}` : `${entry.email} can join again`)
    setList((rows) => (rows ?? []).filter((r) => r.email !== entry.email))
  }

  if (!list) return <p className="pt-1.5 text-sm text-muted-foreground">Loading…</p>
  if (list.length === 0)
    return (
      <p className="pt-1.5 text-sm text-muted-foreground">
        Nobody is removed or blocked.
      </p>
    )

  return (
    <MotionList>
      {list.map((entry) => (
        <MotionItem key={entry.email}>
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm">
                <span className="truncate">{entry.email}</span>
                <Badge size="sm" tone={entry.kind === "blocked" ? "danger" : "neutral"}>
                  {entry.kind === "blocked" ? "Blocked" : "Removed"}
                </Badge>
              </span>
              <span className="block text-xs text-muted-foreground">
                {entry.kind === "blocked"
                  ? `Blocked ${shortDate(new Date(entry.created_at))} · no suggestion, request or auto-join`
                  : `Removed ${shortDate(new Date(entry.created_at))} · can only ask to join again`}
              </span>
            </span>
            <RowMenu visible label={entry.email}>
              <DropdownMenuItem
                disabled={busy !== null}
                onSelect={() => void allow(entry, false)}
              >
                Allow
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy !== null}
                onSelect={() => void allow(entry, true)}
              >
                Allow and invite
              </DropdownMenuItem>
            </RowMenu>
          </div>
        </MotionItem>
      ))}
    </MotionList>
  )
}
