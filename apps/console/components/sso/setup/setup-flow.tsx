"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import type { AccessDomain } from "@/lib/actions"
import {
  addSsoDomain,
  changeSsoConnection,
  createSsoConnection,
  deleteSsoConnection,
  oidcSetup,
  samlSetup,
} from "@/lib/sso-actions"
import { latestPass } from "@/lib/sso-runs"
import { idpChoices } from "@/lib/sso-setup-choices"
import { flowCovers, guideFor, type OidcGuide, type SamlGuide } from "@/lib/sso-guides"
import {
  connectSummary,
  currentStep,
  stepIsDone,
  type SetupStep,
} from "@/lib/sso-setup-flow"
import type {
  OidcSetup,
  SamlSetup,
  SsoConnection,
  SsoConnections,
  SsoDomain,
  TestRun,
} from "@/lib/sso-types"
import { IdpMark } from "../idp-mark"
import { OidcConnectStep } from "./connect-step"
import { DomainStep } from "./domain-step"
import { InlineError } from "./inline-error"
import { LiveStep } from "./live-step"
import { ProviderStep, type ProviderPick } from "./provider-step"
import { SamlConnectStep } from "./saml-connect-step"
import { TestStep } from "./test-step"
import { TimelineStep } from "./timeline"

export function SetupFlow({
  initial,
  catalog,
  initialAccessDomains,
  email,
  authOrigin,
  previewTest,
}: {
  initial: {
    connection: SsoConnection
    setup: OidcSetup | SamlSetup
    runs: TestRun[]
  } | null
  catalog: SsoConnections
  initialAccessDomains?: {
    data: AccessDomain[]
    verified: string[]
    suggested: string[]
  }
  email: string | null
  authOrigin: string | null
  previewTest: boolean
}) {
  const router = useRouter()
  const choices = React.useMemo(() => idpChoices(catalog.presets), [catalog.presets])
  const [connection, setConnection] = React.useState(initial?.connection ?? null)
  const [setup, setSetup] = React.useState<OidcSetup | SamlSetup | null>(
    initial?.setup ?? null,
  )
  const [runs, setRuns] = React.useState(initial?.runs ?? [])
  const [pendingTile, setPendingTile] = React.useState<string | null>(null)
  const [switching, setSwitching] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [now] = React.useState(() => Date.now())

  const pass = latestPass(runs, now)
  const current = currentStep({
    connection,
    ready: setup?.ready ?? false,
    passed: pass !== null,
  })
  const generic = connection?.provider === "generic"
  const label = generic
    ? "your provider"
    : (choices.find((c) => c.idp === connection?.provider)?.label ??
      connection?.name ??
      "")
  const mark = generic ? connection?.protocol : connection?.provider

  React.useEffect(() => {
    const result = new URLSearchParams(window.location.hash.slice(1)).get("sso_test")
    if (!result) return
    if (window.opener) {
      window.close()
      return
    }
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    )
  }, [])

  async function pick(choice: ProviderPick) {
    const tile = choice.idp === "generic" ? `generic-${choice.protocol}` : choice.idp
    setPendingTile(tile)
    setError(null)
    const made = await createSsoConnection({
      name: choice.label,
      protocol: choice.protocol,
      provider: choice.idp,
    })
    if (!made.ok) {
      setPendingTile(null)
      setError(made.error)
      return
    }
    if (!flowCovers(choice.idp, choice.protocol)) {
      router.push(`/settings/sso/${made.data.id}`)
      return
    }
    const values =
      choice.protocol === "saml"
        ? await samlSetup(made.data.id)
        : await oidcSetup(made.data.id)
    setPendingTile(null)
    if (!values.ok) {
      setError(values.error)
      return
    }
    setSetup(values.data)
    setConnection({ ...made.data, domains: [] })
    window.history.replaceState(
      null,
      "",
      `/settings/sso/connect?connection=${made.data.id}`,
    )
  }

  async function changeProvider() {
    if (!connection) return
    const removed = await deleteSsoConnection(connection.id)
    if (!removed.ok) {
      setError(removed.error)
      return
    }
    setConnection(null)
    setSetup(null)
    setRuns([])
    window.history.replaceState(null, "", "/settings/sso/connect")
  }

  async function switchProtocol() {
    if (!connection || connection.status !== "draft") return
    const targetProtocol: "oidc" | "saml" =
      connection.protocol === "oidc" ? "saml" : "oidc"
    const currentDomains = [...connection.domains]
    setSwitching(true)
    setError(null)
    try {
      const removed = await deleteSsoConnection(connection.id)
      if (!removed.ok) {
        setError(removed.error)
        return
      }
      const made = await createSsoConnection({
        name: label,
        protocol: targetProtocol,
        provider: connection.provider,
      })
      if (!made.ok) {
        // The old draft is gone, so the flow starts over rather than point at it.
        setConnection(null)
        setSetup(null)
        window.history.replaceState(null, "", "/settings/sso/connect")
        setError(made.error)
        return
      }
      const attached = []
      for (const d of currentDomains) {
        const added = await addSsoDomain(made.data.id, d.joinDomainId)
        if (added.ok) attached.push(d)
      }
      const values =
        targetProtocol === "saml"
          ? await samlSetup(made.data.id)
          : await oidcSetup(made.data.id)
      if (!values.ok) {
        setError(values.error)
        return
      }
      setConnection({ ...made.data, domains: attached })
      setSetup(values.data)
      setRuns([])
      window.history.replaceState(
        null,
        "",
        `/settings/sso/connect?connection=${made.data.id}`,
      )
    } finally {
      setSwitching(false)
    }
  }

  /** A write answers without `domains`; the flow's own copy stays the truth. */
  function keepDomains(answer: SsoConnection) {
    setConnection((c) => (c ? { ...c, ...answer, domains: c.domains } : answer))
  }

  const onAttached = React.useCallback((domain: SsoDomain) => {
    setConnection((c) => (c ? { ...c, domains: [...c.domains, domain] } : c))
  }, [])

  async function onSaved(after: OidcSetup | SamlSetup): Promise<string | null> {
    if (!connection) return null
    setSetup(after)
    if (!after.ready)
      return `Those values are not complete yet. Check them against ${label}.`
    const moved =
      connection.status === "draft"
        ? await changeSsoConnection(connection.id, { status: "testing" })
        : null
    if (moved && !moved.ok) return moved.error
    if (moved?.ok) keepDomains(moved.data)
    setSetup(after)
    return null
  }

  const guide = connection ? guideFor(connection.provider, connection.protocol) : null
  const choice = choices.find((c) => c.idp === connection?.provider)
  const hasBoth = Boolean(
    choice && choice.protocols.includes("oidc") && choice.protocols.includes("saml"),
  )
  const canSwitch = connection?.status === "draft" && hasBoth

  const stateOf = (step: SetupStep) =>
    stepIsDone(step, current) ? "done" : current === step ? "open" : "waiting"

  const done = current === "done"
  const heading = done
    ? `${connection?.name} is connected`
    : connection
      ? `Connect ${label}`
      : "Connect your identity provider"
  const others = catalog.data.filter((c) => c.id !== connection?.id)

  return (
    <div className="max-w-2xl">
      <Link
        href="/settings/sso"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Single sign-on
      </Link>

      <header className="mt-4 flex items-center">
        <AnimatePresence initial={false}>
          {connection && (
            <motion.span
              key="mark"
              // ⚠ THE SPACE BESIDE THE MARK MOVES WITH IT: a flex gap would stay until
              // the mark unmounts, and the heading would then snap across it.
              initial={{ opacity: 0, scale: 0.8, width: 0, marginRight: 0 }}
              animate={{ opacity: 1, scale: 1, width: 40, marginRight: 12 }}
              exit={{ opacity: 0, scale: 0.8, width: 0, marginRight: 0 }}
              transition={motionTokens.spring.smooth}
              className="overflow-hidden"
            >
              <IdpMark idp={mark ?? "oidc"} />
            </motion.span>
          )}
        </AnimatePresence>
        <div className="min-w-0">
          <h1 className="text-lg font-medium">{heading}</h1>
          <p className="text-sm text-muted-foreground">
            {done
              ? "Your team can sign in with their company account."
              : "Takes about five minutes. Nothing changes for your team until the last step."}
          </p>
        </div>
      </header>

      <InlineError message={error} />

      <ol className="mt-8">
        <TimelineStep
          index={1}
          title="Choose your provider"
          state={stateOf("provider")}
          summary={connection?.name}
          action={
            current !== "done" && connection?.status === "draft" ? (
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
                onClick={() => void changeProvider()}
              >
                Change
              </button>
            ) : undefined
          }
        >
          <ProviderStep
            choices={choices}
            pending={pendingTile}
            onPick={(c) => void pick(c)}
          />
        </TimelineStep>

        <TimelineStep
          index={2}
          title="Add your domain"
          state={stateOf("domain")}
          summary={connection?.domains.map((d) => d.name).join(", ")}
        >
          <DomainStep
            open={current === "domain"}
            connectionId={connection?.id ?? null}
            provider={connection?.provider}
            email={email}
            others={others}
            initialAccessDomains={initialAccessDomains}
            initialConnections={catalog.data}
            onAttached={onAttached}
          />
        </TimelineStep>

        <TimelineStep
          index={3}
          title={connection ? `Connect ${label}` : "Connect it"}
          state={stateOf("connect")}
          summary={connectSummary(setup, label)}
        >
          {connection &&
            setup &&
            guide &&
            (connection.protocol === "saml" ? (
              <SamlConnectStep
                connectionId={connection.id}
                setup={setup as SamlSetup}
                guide={guide as SamlGuide}
                providerLabel={label}
                authOrigin={authOrigin}
                onSaved={onSaved as (setup: SamlSetup) => Promise<string | null>}
                onSwitchProtocol={canSwitch ? () => void switchProtocol() : undefined}
                switchingProtocol={switching}
              />
            ) : (
              <OidcConnectStep
                connectionId={connection.id}
                setup={setup as OidcSetup}
                guide={guide as OidcGuide}
                providerLabel={label}
                authOrigin={authOrigin}
                onSaved={onSaved as (setup: OidcSetup) => Promise<string | null>}
                onSwitchProtocol={canSwitch ? () => void switchProtocol() : undefined}
                switchingProtocol={switching}
              />
            ))}
        </TimelineStep>

        <TimelineStep
          index={4}
          title="Test it"
          state={stateOf("test")}
          summary={
            pass && typeof pass.resolution.email === "string"
              ? `Signed in as ${pass.resolution.email}`
              : "Test sign-in passed"
          }
        >
          {connection && (
            <TestStep
              open={current === "test"}
              connectionId={connection.id}
              providerLabel={label}
              authOrigin={authOrigin}
              previewTest={previewTest}
              runs={runs}
              onRuns={setRuns}
            />
          )}
        </TimelineStep>

        <TimelineStep
          index={5}
          title="Turn it on"
          state={stateOf("live")}
          last
          summary={
            connection?.enforcement === "optional"
              ? "Offered at sign-in"
              : "Required at sign-in"
          }
        >
          {connection && (
            <LiveStep
              connection={connection}
              providerLabel={label}
              onLive={keepDomains}
            />
          )}
        </TimelineStep>
      </ol>

      <Reveal show={current === "done"} spacing="pt-4">
        {connection && (
          <div className="space-y-3 rounded-2xl border border-border p-4">
            <div>
              <p className="text-sm font-medium">Single sign-on is on</p>
              <p className="text-sm text-muted-foreground">
                {authOrigin
                  ? "Share this link with your team, or let them type their email at sign-in."
                  : "Your team can type their email at sign-in to use it."}
              </p>
            </div>
            {authOrigin && <CopyField value={`${authOrigin}/sso/${connection.id}`} />}
            <ButtonLink
              href={`/settings/sso/${connection.id}`}
              variant="secondary"
              size="sm"
            >
              Open connection settings
            </ButtonLink>
          </div>
        )}
      </Reveal>
    </div>
  )
}
