"use client"

import { finishDnsConnect } from "@/lib/actions"
import { activateDomain } from "@/lib/domain-activation"
import type { Domain } from "@/lib/types"

/**
 * Finishing a DNS provider connection: the code exchange, then publishing and
 * checking every unverified domain (2026-10-13).
 *
 * ⚠ ONE PIPELINE, TWO PLACES. The callback page runs it for a connection
 * started from a domain page's own Connect button. One started from the
 * add-domain steps - set-up's domain step or /domains/new - does NOT stop on
 * that page: it hands the code back to where it started and
 * `DomainLiveProvider` runs this under the domain's events, phase by phase.
 *
 * ⚠ THE HAND-OVER IS `sessionStorage`, WHICH SURVIVES THE PROVIDER'S ROUND TRIP.
 * It is per tab and per origin, so the tab that left is the only one that
 * finds it, and nothing about the code ever reaches a URL or a cookie.
 */

/** Where the connection itself is. `done` is the whole run finishing. */
export type ConnectPhase = "connecting" | "connected" | "done" | "failed"

/**
 * Where one domain is: on its way, or how it ended.
 *
 * ⚠ ONE VALUE PER DOMAIN, BECAUSE "THE RUN IS DONE" SAYS NOTHING ABOUT ANY OF
 * THEM. The run used to report one phase for everything, and a page showed
 * "Publishing your records" ticked for a domain whose records the provider
 * had refused - the run had finished, so every row read as passed.
 */
export type DomainStage =
  | { kind: "publishing" }
  | { kind: "checking" }
  /** Written. `checked` is whether the check that followed answered. */
  | { kind: "published"; checked: boolean }
  /** Records already at the names we need. Nothing was written. */
  | { kind: "blocked" }
  /** The connection holds no zone for this domain. Nothing was attempted. */
  | { kind: "unreachable"; zones: string[] }
  /** Refused. `reason` is what the API said, or our catch-all when it said nothing. */
  | { kind: "failed"; reason: string }

export type FinalStage = Exclude<
  DomainStage,
  { kind: "publishing" } | { kind: "checking" }
>

export interface DomainResult {
  id: string
  name: string
  stage: FinalStage
}

export interface ConnectOutcome {
  ok: boolean
  error?: string
  returnTo: string | null
  results: DomainResult[]
  /** The last answer about each published domain, to show without a refetch. */
  domains: Domain[]
}

export const PUBLISH_FAILED =
  "Something went wrong while publishing your records. Try again, or add the records by hand from the domain page."

const CONNECT_FAILED = "The connection could not be finished. Try connecting again."

/**
 * The sentence for a domain that ended without its records, or null when they
 * were written.
 */
export function stageProblem(
  stage: FinalStage,
  domainName: string,
  providerName: string,
): string | null {
  switch (stage.kind) {
    case "published":
      return null
    case "blocked":
      return `${domainName} already has records at the names we need, so we published nothing. Press Publish records on the domain page to see them and choose whether to replace them.`
    case "unreachable":
      return (
        `This ${providerName} connection cannot see ${domainName}, so we published nothing. ` +
        (stage.zones.length > 0
          ? `It reaches ${stage.zones.join(", ")}.`
          : "It reaches no zones at all.")
      )
    case "failed":
      return stage.reason
  }
}

const LEAVING = "i10.dns-connect.leaving"
const RETURNED = "i10.dns-connect.returned"

interface Leaving {
  name: string
  returnTo: string
}

interface Returned {
  provider: string
  name: string
  code: string
  state: string
}

function read<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) window.sessionStorage.removeItem(key)
    else window.sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode: the callback page runs it instead, as it always did.
  }
}

/** Called just before leaving for the provider's sign-in. */
export function rememberLeaving(leaving: Leaving) {
  write(LEAVING, leaving)
}

/**
 * On the callback page: where this tab left from, if it was the add-domain
 * steps - set-up's domain step or /domains/new, which are the same steps and
 * come back to the same thing. The code is handed over and the caller sends
 * the browser back there, where `DomainLiveProvider` finishes it. Null for
 * anything else (a domain page's own Connect button), which this page runs.
 */
export function handOverPath(
  provider: string,
  code: string,
  state: string,
): string | null {
  const leaving = read<Leaving>(LEAVING)
  write(LEAVING, null)
  if (!leaving) return null
  const back = leaving.returnTo
  // Only paths of ours that render the live domain: never an open redirect.
  if (!/^\/(onboarding(\?|$)|domains\/[\w-]+$)/.test(back)) return null
  write(RETURNED, { provider, name: leaving.name, code, state } satisfies Returned)
  return read<Returned>(RETURNED) !== null ? back : null
}

/** On the page it came back to: the connection to finish, taken exactly once. */
export function takeReturned(): Returned | null {
  const returned = read<Returned>(RETURNED)
  write(RETURNED, null)
  return returned
}

/** The provider's name for a slug we have no record of (a direct visit). */
export function providerLabel(slug: string): string {
  const known: Record<string, string> = {
    cloudflare: "Cloudflare",
    godaddy: "GoDaddy",
    digitalocean: "DigitalOcean",
    dnsimple: "DNSimple",
    hetzner: "Hetzner",
  }
  return known[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1)
}

export async function runDnsConnect({
  provider,
  code,
  state,
  onPhase,
  onDomain,
}: {
  provider: string
  code: string
  state: string
  onPhase?: (phase: ConnectPhase) => void
  onDomain?: (domainId: string, stage: DomainStage) => void
}): Promise<ConnectOutcome> {
  onPhase?.("connecting")
  const connected = await finishDnsConnect({ provider, code, state })
  if (!connected.ok) {
    const detail =
      typeof connected.body?.detail === "string" ? connected.body.detail : null
    const error = connected.error || CONNECT_FAILED
    onPhase?.("failed")
    return {
      ok: false,
      error: detail ? `${error} (${detail})` : error,
      returnTo: null,
      results: [],
      domains: [],
    }
  }
  /*
   * ⚠ CHECKED, NOT ASSUMED: THE API IS A SEPARATE DEPLOY. One that predates
   * `pending` answers without it, and reading it as "nothing to publish" would
   * say "Connected" over domains nobody touched.
   */
  if (!Array.isArray(connected.data.pending)) {
    onPhase?.("failed")
    return {
      ok: false,
      error: CONNECT_FAILED,
      returnTo: null,
      results: [],
      domains: [],
    }
  }
  onPhase?.("connected")

  const outcome: ConnectOutcome = {
    ok: true,
    returnTo: connected.data.return_to ?? null,
    results: [],
    domains: [],
  }
  const settle = (domain: { id: string; name: string }, stage: FinalStage) => {
    outcome.results.push({ id: domain.id, name: domain.name, stage })
    onDomain?.(domain.id, stage)
  }

  for (const domain of connected.data.pending) {
    if (domain.zone === null) {
      settle(domain, { kind: "unreachable", zones: connected.data.zones })
      continue
    }
    const activation = await activateDomain({
      domainId: domain.id,
      provider,
      onStage: (stage) => onDomain?.(domain.id, { kind: stage }),
    })
    switch (activation.kind) {
      case "conflicts":
        settle(domain, { kind: "blocked" })
        break
      case "failed":
        settle(domain, { kind: "failed", reason: activation.reason || PUBLISH_FAILED })
        break
      case "verified":
        outcome.domains.push(activation.domain)
        settle(domain, { kind: "published", checked: true })
        break
      case "published":
        if (activation.domain) outcome.domains.push(activation.domain)
        settle(domain, { kind: "published", checked: activation.checked })
        break
    }
  }
  onPhase?.("done")
  return outcome
}
