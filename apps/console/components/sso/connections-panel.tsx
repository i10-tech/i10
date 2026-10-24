"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ChevronRight, KeyRound } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { FloatingInput } from "@repo/ui/components/i10/floating-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { RadioCards } from "@repo/ui/components/radio-cards/radio-cards"
import { teamAccessDomains, type AccessDomain } from "@/lib/actions"
import { addSsoDomain, createSsoConnection } from "@/lib/sso-actions"
import type { SsoAbilities, SsoConnections } from "@/lib/sso-types"
import { useResetOnOpen } from "@/lib/react"
import { toastDone } from "@/lib/toast"
import { ENFORCEMENT_LABEL, StatusBadge, useSsoCall } from "./shared"

/**
 * The workspace's SSO connections, and the wizard that makes one (sso.md 2.10):
 * a verified access domain, then the identity provider with its guide, then a
 * name. The IdP settings themselves are the connection's own page.
 *
 * ⚠ A DOMAIN IS NEVER INVENTED HERE. It is one the workspace already proved on
 * the Team page (a TXT record or a verified sending domain); this lists those
 * and links to where a new one is proved. The API checks it again.
 */

type IdpChoice = { idp: string; label: string; protocols: ("oidc" | "saml")[] }

/** The identity providers, merged across the two protocols' presets. */
function idpChoices(presets: SsoConnections["presets"]): IdpChoice[] {
  const byId = new Map<string, IdpChoice>()
  for (const p of presets.oidc)
    byId.set(p.id, { idp: p.id, label: p.label, protocols: ["oidc"] })
  for (const p of presets.saml) {
    const existing = byId.get(p.id)
    if (existing) existing.protocols.push("saml")
    else byId.set(p.id, { idp: p.id, label: p.label, protocols: ["saml"] })
  }
  // The generic presets are one choice for both protocols, so neither
  // preset's own label ("Other OpenID Connect provider") fits it.
  const generic = byId.get("generic")
  if (generic && generic.protocols.length > 1) generic.label = "Another provider"
  return [...byId.values()]
}

export function ConnectionsPanel({
  initial,
  abilities,
}: {
  initial: SsoConnections | null
  abilities: SsoAbilities
}) {
  const [creating, setCreating] = React.useState(false)
  if (!initial)
    return (
      <p className="py-2 text-sm text-muted-foreground">
        Could not load this workspace&rsquo;s SSO connections. Reload to try again.
      </p>
    )
  const { data, presets, protocols } = initial

  return (
    <div className="space-y-3">
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No connection yet. Connect your company&rsquo;s identity provider so people
          sign in with the account they already have.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {data.map((c) => (
            <li key={c.id}>
              <Link
                href={`/settings/security/${c.id}`}
                className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/50"
              >
                <KeyRound className="size-4 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {c.protocol.toUpperCase()} &middot;{" "}
                    {ENFORCEMENT_LABEL[c.enforcement]} &middot;{" "}
                    {c.domains.length
                      ? c.domains.map((d) => d.name).join(", ")
                      : "no domain yet"}
                  </span>
                </span>
                <StatusBadge status={c.status} />
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setCreating(true)}
          disabled={!abilities.manage || !protocols.some((p) => p !== "test")}
        >
          New connection
        </Button>
        {!abilities.manage && (
          <p className="mt-2 text-xs text-muted-foreground">
            Only an admin or an owner can set up SSO.
          </p>
        )}
      </div>
      <NewConnection open={creating} onOpenChange={setCreating} presets={presets} />
    </div>
  )
}

function NewConnection({
  open,
  onOpenChange,
  presets,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  presets: SsoConnections["presets"]
}) {
  const router = useRouter()
  const call = useSsoCall()
  const choices = React.useMemo(() => idpChoices(presets), [presets])
  const [step, setStep] = React.useState<"domain" | "idp" | "name">("domain")
  const [domains, setDomains] = React.useState<AccessDomain[] | null>(null)
  const [domain, setDomain] = React.useState<string | null>(null)
  const [idp, setIdp] = React.useState<string | null>(null)
  const [protocol, setProtocol] = React.useState<"oidc" | "saml">("oidc")
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  useResetOnOpen(open, () => {
    setStep("domain")
    setDomain(null)
    setIdp(null)
    setProtocol("oidc")
    setName("")
    setBusy(false)
    setDomains(null)
  })

  // ⚠ AN EFFECT, NOT THE RESET: `useResetOnOpen` runs during render, and a
  // server action called there updates the router while this renders.
  React.useEffect(() => {
    if (!open) return
    let live = true
    void teamAccessDomains().then((r) => {
      if (live)
        setDomains(r.ok ? r.data.data.filter((d) => d.status === "verified") : [])
    })
    return () => {
      live = false
    }
  }, [open])

  const choice = choices.find((c) => c.idp === idp) ?? null
  const guide =
    choice &&
    (protocol === "saml"
      ? presets.saml.find((p) => p.id === choice.idp)?.requires
      : presets.oidc.find((p) => p.id === choice.idp)?.requires)

  function pickIdp(next: string) {
    setIdp(next)
    const c = choices.find((x) => x.idp === next)
    const chosen = c?.protocols.includes(protocol)
      ? protocol
      : (c?.protocols[0] ?? "oidc")
    setProtocol(chosen)
    setName(`${c?.label ?? next} (${chosen === "oidc" ? "OIDC" : "SAML"})`)
  }

  async function create() {
    if (!choice) return
    setBusy(true)
    try {
      const made = await call(
        () =>
          createSsoConnection({ name: name.trim(), protocol, provider: choice.idp }),
        { stepUp: false, title: "Could not create the connection" },
      )
      if (!made) return
      if (domain) {
        const joined = await call(() => addSsoDomain(made.id, domain), {
          title: "The connection was created, but its domain was not added",
        })
        if (joined === null) {
          router.push(`/settings/security/${made.id}`)
          onOpenChange(false)
          return
        }
      }
      toastDone("Connection created", "Enter your identity provider's settings next.")
      router.push(`/settings/security/${made.id}`)
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        title="New SSO connection"
        description={
          step === "domain"
            ? "Which verified domain should sign in through your identity provider?"
            : step === "idp"
              ? "Which identity provider does your company use?"
              : "Name it, so you can tell connections apart."
        }
        style={{ width: "min(calc(100vw - 2rem), 512px)" }}
      >
        <div className="space-y-4 py-4">
          {step === "domain" && (
            <>
              {domains === null ? (
                <p className="text-sm text-muted-foreground">Loading domains…</p>
              ) : domains.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  You have no verified access domain yet. Prove one on the{" "}
                  <Link
                    href="/settings/team"
                    className="text-foreground underline underline-offset-4"
                  >
                    Team page
                  </Link>{" "}
                  first, or continue and add it later - a connection cannot go live
                  without one.
                </p>
              ) : (
                <RadioCards
                  aria-label="Access domain"
                  layout="list"
                  value={domain}
                  onValueChange={setDomain}
                  options={domains.map((d) => ({
                    value: d.id,
                    label: d.name,
                    description:
                      d.source === "txt"
                        ? "Proved with a TXT record"
                        : "A verified sending domain",
                  }))}
                />
              )}
              <p className="text-xs text-muted-foreground">
                Someone signs in through SSO only with an address on a domain you proved
                here.
              </p>
            </>
          )}

          {step === "idp" && (
            <>
              <RadioCards
                aria-label="Identity provider"
                layout="list"
                value={idp}
                onValueChange={pickIdp}
                options={choices.map((c) => ({
                  value: c.idp,
                  label: c.label,
                  description: c.protocols.map((p) => p.toUpperCase()).join(" or "),
                }))}
              />
              {choice && choice.protocols.length > 1 && (
                <MorphSelect
                  label="Protocol"
                  value={protocol}
                  onValueChange={(v) => {
                    setProtocol(v as "oidc" | "saml")
                    setName(`${choice.label} (${v === "oidc" ? "OIDC" : "SAML"})`)
                  }}
                  items={choice.protocols.map((p) => ({
                    value: p,
                    label: p === "oidc" ? "OpenID Connect (recommended)" : "SAML 2.0",
                  }))}
                />
              )}
              {guide && guide.length > 0 && (
                <div className="rounded-lg border bg-muted/40 p-3">
                  <p className="text-xs font-medium">
                    What you will set up at {choice?.label}
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                    {guide.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {step === "name" && (
            <FloatingInput
              label="Connection name"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {step !== "domain" && (
            <Button
              variant="secondary"
              onClick={() => setStep(step === "name" ? "idp" : "domain")}
              disabled={busy}
            >
              Back
            </Button>
          )}
          {step === "domain" && (
            <Button onClick={() => setStep("idp")} disabled={domains === null}>
              {domain ? "Continue" : "Continue without a domain"}
            </Button>
          )}
          {step === "idp" && (
            <Button onClick={() => setStep("name")} disabled={!choice}>
              Continue
            </Button>
          )}
          {step === "name" && (
            <Button onClick={create} loading={busy} disabled={!name.trim() || !choice}>
              Create connection
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
