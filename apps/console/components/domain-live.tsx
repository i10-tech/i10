"use client"

import * as React from "react"
import { DetailHero } from "@/components/detail-hero"
import { DnsRecordsCard } from "@/components/dns-records"
import { Journey } from "@/components/journey"
import { Status, describeStatus } from "@/components/status"
import { PAGE_WATCH_MS, watchUntilVerified } from "@/lib/domain-activation"
import { domainJourney, domainNotice } from "@/lib/journey"
import { useResetWhen } from "@/lib/react"
import type { Domain } from "@/lib/types"

/**
 * One domain, held in the browser, so its page updates in place (2026-10-03).
 *
 * ⚠ THE PARTS OF THE DOMAIN PAGE THAT CHANGE WHILE SOMEBODY WATCHES READ FROM
 * HERE: the header tile's colour, the status pill, the events strip and its
 * notice, and the records. The watch below and the Verify button put each new
 * answer into this state and those parts re-render - nothing else on the page
 * does, and no server render is asked for. It replaced `router.refresh()` on
 * every change, which re-ran every read on the page (the lookup, the keys, the
 * delegation report) to move one badge.
 *
 * ⚠ THE SERVER'S RENDER STILL WINS WHEN IT CHANGES. Something else on the page
 * that revalidates - publishing the records, a tracking toggle - re-renders it
 * with a fresher domain, and that replaces what is held here.
 */

interface Live {
  domain: Domain
  /** A newer answer for this domain, from a check that ran in the browser. */
  update: (domain: Domain) => void
}

const LiveDomain = React.createContext<Live | null>(null)

/** The live domain, or null outside a domain page. */
export function useLiveDomain(): Live | null {
  return React.useContext(LiveDomain)
}

function useLive(): Live {
  const live = React.useContext(LiveDomain)
  if (!live) throw new Error("Live domain parts must sit inside DomainLiveProvider")
  return live
}

/** What the page shows, as one string: the status and every record's. */
function stateKey(domain: Domain): string {
  return `${domain.status}:${domain.records.map((r) => r.status).join(",")}`
}

export function DomainLiveProvider({
  initial,
  children,
}: {
  initial: Domain
  children: React.ReactNode
}) {
  const [domain, setDomain] = React.useState(initial)
  useResetWhen(stateKey(initial), () => setDomain(initial))

  const update = React.useCallback(
    (next: Domain) =>
      setDomain((current) => (stateKey(current) === stateKey(next) ? current : next)),
    [],
  )

  /*
   * ⚠ IT WATCHES RATHER THAN WAITING TO BE ASKED, UNTIL IT IS VERIFIED OR HAS
   * FAILED. While the domain has no SES identity each tick is a verify, which
   * registers it the moment ownership is proved; after that it is a read. See
   * `PAGE_WATCH_MS` for the budget and why hidden tabs do not tick.
   *
   * ⚠ RESTARTED ONLY WHEN WATCHING TURNS ON OR OFF, not on every answer: the
   * answers land in state, and a watch that restarted for each one would go
   * back to its fastest schedule forever.
   */
  const watching = domain.status !== "verified" && domain.status !== "failed"
  React.useEffect(() => {
    if (!watching) return
    const controller = new AbortController()
    void watchUntilVerified({
      domainId: initial.id,
      signal: controller.signal,
      schedule: PAGE_WATCH_MS,
      quiet: true,
      onTick: update,
    })
    return () => controller.abort()
  }, [initial.id, watching, update])

  const value = React.useMemo(() => ({ domain, update }), [domain, update])
  return <LiveDomain.Provider value={value}>{children}</LiveDomain.Provider>
}

/** The header, its tile coloured by the live status. */
export function LiveDomainHero(
  props: Omit<React.ComponentProps<typeof DetailHero>, "tone">,
) {
  const { domain } = useLive()
  return (
    <DetailHero
      {...props}
      tone={domain.displaced_at ? "danger" : describeStatus(domain.status).tone}
    />
  )
}

export function LiveDomainStatus() {
  const { domain } = useLive()
  return (
    <Status
      status={domain.status}
      label={domain.displaced_at ? "Verified elsewhere" : undefined}
      variant="pill"
    />
  )
}

/**
 * The events strip, and its notice.
 *
 * ⚠ `quiet` IS DECIDED ON THE SERVER: a delegation report or a displaced
 * domain says something more specific than the generic notice, and the two
 * shown together contradict each other - see the domain page.
 */
export function LiveDomainJourney({ quiet }: { quiet: boolean }) {
  const { domain } = useLive()
  return (
    <Journey
      title="Domain events"
      steps={domainJourney(domain)}
      notice={quiet ? null : domainNotice(domain.status, domain.delegated)}
    />
  )
}

export function LiveDomainRecords({ actions }: { actions?: React.ReactNode }) {
  const { domain } = useLive()
  return <DnsRecordsCard records={domain.records} actions={actions} />
}

/** Renders its children only while the domain is not yet verified. */
export function WhileUnverified({ children }: { children: React.ReactNode }) {
  const { domain } = useLive()
  return domain.status === "verified" ? null : children
}
