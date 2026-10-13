"use client"

import { finishDnsConnect, listDomains } from "@/lib/actions"
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

export type ConnectPhase = "connecting" | "publishing" | "checking" | "done" | "failed"

export interface ConnectOutcome {
  ok: boolean
  error?: string
  returnTo: string | null
  /** Domains whose records we wrote. */
  publishedIds: string[]
  /** Domains with existing records in the way. */
  blocked: string[]
  /** Published, but the check after it did not answer. */
  unchecked: string[]
  /** The last answer about each published domain, to show without a refetch. */
  domains: Domain[]
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
}: {
  provider: string
  code: string
  state: string
  onPhase?: (phase: ConnectPhase) => void
}): Promise<ConnectOutcome> {
  const empty = { publishedIds: [], blocked: [], unchecked: [], domains: [] }
  onPhase?.("connecting")
  const connected = await finishDnsConnect({ provider, code, state })
  if (!connected.ok) {
    const detail =
      typeof connected.body?.detail === "string" ? connected.body.detail : null
    onPhase?.("failed")
    return {
      ok: false,
      error: detail ? `${connected.error} (${detail})` : connected.error,
      returnTo: null,
      ...empty,
    }
  }

  onPhase?.("publishing")
  const listed = await listDomains()
  const pending = listed.ok
    ? listed.data.data.filter((domain) => domain.status !== "verified")
    : []

  const outcome: ConnectOutcome = {
    ok: true,
    returnTo: connected.data.return_to ?? null,
    ...empty,
  }
  for (const domain of pending) {
    const activation = await activateDomain({
      domainId: domain.id,
      provider,
      onStage: (stage) => onPhase?.(stage),
    })
    if (activation.kind === "conflicts") {
      outcome.blocked.push(domain.name)
      continue
    }
    if (activation.kind === "failed") continue
    outcome.publishedIds.push(domain.id)
    if (activation.domain) outcome.domains.push(activation.domain)
    if (activation.kind === "published" && !activation.checked)
      outcome.unchecked.push(domain.name)
  }
  onPhase?.("done")
  return outcome
}
