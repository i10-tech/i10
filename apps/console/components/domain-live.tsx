"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ConnectProgress, type ConnectView } from "@/components/connect-progress"
import { DetailHero } from "@/components/detail-hero"
import { DnsRecordsCard } from "@/components/dns-records"
import { Journey } from "@/components/journey"
import { Status, describeStatus } from "@/components/status"
import { PAGE_WATCH_MS, watchUntilVerified } from "@/lib/domain-activation"
import { domainJourney, domainNotice } from "@/lib/journey"
import { useResetWhen } from "@/lib/react"
import { runDnsConnect, takeReturned } from "@/lib/dns-connect"
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
  /**
   * A DNS provider connection being finished on this page, back from the
   * provider's sign-in. Set-up's verify step and the domain page that
   * /domains/new returns to show the same phases. Null otherwise.
   */
  connect: ConnectView | null
}

const LiveDomain = React.createContext<Live | null>(null)

/**
 * Hands the provider a domain to hold, even before it holds one (2026-10-13).
 * The add-domain steps sit inside set-up's provider: "I've added the records"
 * puts its answer here at once, so the verify step that opens next already
 * knows - rather than waiting on a server render to come round.
 */
const AdoptDomain = React.createContext<((domain: Domain) => void) | null>(null)

/** Null outside a provider (the /domains/new page, which navigates instead). */
export function useAdoptDomain() {
  return React.useContext(AdoptDomain)
}

/** The live domain, or null outside a domain page. */
export function useLiveDomain(): Live | null {
  return React.useContext(LiveDomain)
}

function useLive(): Live {
  const live = React.useContext(LiveDomain)
  if (!live) throw new Error("Live domain parts must sit inside DomainLiveProvider")
  return live
}

/** What the page shows, as one string: which domain, its status and every record's. */
function stateKey(domain: Domain | null): string {
  if (!domain) return ""
  // ⚠ `records_added_at` IS PART OF IT (2026-10-13). Without it, set-up held
  // the domain from the moment it was created, and the render that came back
  // after "I've added the records" looked identical and was dropped - so the
  // verify step still asked for the records and offered the button again.
  return `${domain.id}:${domain.status}:${domain.records.map((r) => r.status).join(",")}:${domain.records_added_at ? "added" : ""}`
}

/**
 * ⚠ `initial` MAY BE NULL, AND THE PROVIDER IS RENDERED EITHER WAY. Set-up has
 * no domain until somebody adds one; wrapping its tree in this provider only
 * once a domain existed changed the tree's shape at that moment, and React
 * remounted everything inside - the add-domain steps lost the step they were
 * on and set-up forgot it was adding, the moment the new domain arrived.
 * Rendered always and never keyed, the tree stays put and only the value
 * changes.
 */
export function DomainLiveProvider({
  initial,
  children,
}: {
  initial: Domain | null
  children: React.ReactNode
}) {
  const [domain, setDomain] = React.useState(initial)
  useResetWhen(stateKey(initial), () => setDomain(initial))

  const update = React.useCallback(
    (next: Domain) =>
      setDomain((current) => {
        // ⚠ THE PUBLIC ANSWERS (verify, refresh) DO NOT CARRY THE CONSOLE'S
        // OWN FIELDS: a tick must not take "they added the records" away.
        const merged: Domain = {
          ...next,
          records_added_at: next.records_added_at ?? current?.records_added_at ?? null,
        }
        return stateKey(current) === stateKey(merged) ? current : merged
      }),
    [],
  )
  const id = domain?.id ?? null

  /*
   * ⚠ BACK FROM THE DNS PROVIDER, THE CONNECTION IS FINISHED HERE (2026-10-13),
   * wherever the person started it - set-up's domain step or /domains/new,
   * which are the same steps (AddDomainSteps) and now come back to the same
   * thing: the callback page hands the code over and this runs the phases
   * under the domain's events. See lib/dns-connect.ts.
   */
  const router = useRouter()
  const [connect, setConnect] = React.useState<ConnectView | null>(null)
  React.useEffect(() => {
    const returned = takeReturned()
    if (!returned) return
    void Promise.resolve()
      .then(() =>
        setConnect({
          name: returned.name,
          phase: "connecting",
          blocked: [],
          unchecked: [],
        }),
      )
      .then(() =>
        runDnsConnect({
          provider: returned.provider,
          code: returned.code,
          state: returned.state,
          onPhase: (phase) => {
            if (phase === "done" || phase === "failed") return
            setConnect((view) => (view ? { ...view, phase } : view))
          },
        }),
      )
      .then((outcome) => {
        setConnect((view) =>
          view
            ? {
                ...view,
                phase: outcome.ok ? "done" : "failed",
                error: outcome.error,
                blocked: outcome.blocked,
                unchecked: outcome.unchecked,
              }
            : view,
        )
        // The answers the checks gave, at once; the refresh brings the rest.
        for (const checked of outcome.domains) {
          setDomain((current) =>
            current &&
            current.id === checked.id &&
            stateKey(current) !== stateKey(checked)
              ? checked
              : current,
          )
        }
        router.refresh()
      })
  }, [router])

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
  const watching =
    domain !== null && domain.status !== "verified" && domain.status !== "failed"
  React.useEffect(() => {
    if (!watching || !id) return
    const controller = new AbortController()
    void watchUntilVerified({
      domainId: id,
      signal: controller.signal,
      schedule: PAGE_WATCH_MS,
      quiet: true,
      onTick: update,
    })
    return () => controller.abort()
  }, [id, watching, update])

  const value = React.useMemo(
    () => (domain ? { domain, update, connect } : null),
    [domain, update, connect],
  )
  return (
    <AdoptDomain.Provider value={update}>
      <LiveDomain.Provider value={value}>{children}</LiveDomain.Provider>
    </AdoptDomain.Provider>
  )
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
export function LiveDomainJourney({
  quiet,
  publishedByUs,
  recordsBelow,
  children,
}: {
  quiet: boolean
  publishedByUs?: boolean
  recordsBelow?: boolean
  /** Shown inside the card, under the events. */
  children?: React.ReactNode
}) {
  const { domain, connect } = useLive()
  // A connection in progress says what is happening itself, under the strip.
  const connecting = connect !== null && connect.phase !== "failed"
  return (
    <Journey
      title="Domain events"
      steps={domainJourney(domain)}
      notice={
        quiet || connecting
          ? null
          : domainNotice(domain.status, domain.delegated, {
              // Records we wrote, or ones they told us they added: either
              // way it is DNS being waited on, not them.
              publishedByUs:
                publishedByUs || connect !== null || Boolean(domain.records_added_at),
              recordsBelow,
            })
      }
      footer={
        <>
          {connect && (
            <ConnectProgress view={connect} verified={domain.status === "verified"} />
          )}
          {children}
        </>
      }
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
