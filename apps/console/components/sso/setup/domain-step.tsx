"use client"

import * as React from "react"
import { X } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { Spinner } from "@repo/ui/components/i10/spinner"
import { ValidatedInput } from "@repo/ui/components/i10/validated-field"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { Journey, type JourneyNotice } from "@/components/journey"
import { domainProblem } from "@/lib/domain-check"
import {
  addAccessDomain,
  removeAccessDomain,
  teamAccessDomains,
  verifyAccessDomain,
  type AccessDomain,
} from "@/lib/actions"
import { addSsoDomain, ssoConnections } from "@/lib/sso-actions"
import { domainChoices } from "@/lib/sso-domain-choices"
import { emailDomain, isMicrosoftOwnedDomain } from "@/lib/sso-setup-flow"
import type { SsoConnection, SsoDomain } from "@/lib/sso-types"
import { InlineError } from "./inline-error"
import { useBringStepUp } from "./timeline"

const CHECK_EVERY_MS = 5000

const MICROSOFT_OWNED =
  "Microsoft owns onmicrosoft.com domains. Use your company's own domain."

type Loaded = {
  access: AccessDomain[]
  /** Sending domains already proven, so they need no record. */
  sending: string[]
  taken: Map<string, string>
}

function DiscardDomain({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Remove ${name}`}
      title="Remove this domain"
      className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
    >
      <X aria-hidden="true" className="size-4" />
    </button>
  )
}

export function DomainStep({
  open,
  connectionId,
  provider,
  email,
  others,
  initialAccessDomains,
  initialConnections,
  onAttached,
}: {
  open: boolean
  connectionId: string | null
  provider?: string
  email: string | null
  others: SsoConnection[]
  initialAccessDomains?: {
    data: AccessDomain[]
    verified: string[]
    suggested: string[]
  }
  initialConnections?: SsoConnection[]
  onAttached: (domain: SsoDomain) => void
}) {
  const [loaded, setLoaded] = React.useState<Loaded | null>(() => {
    if (!initialAccessDomains) return null
    const access = initialAccessDomains.data
    const everyone = initialConnections ?? others
    const verified = access.filter((d) => d.status === "verified")
    const choices = domainChoices(verified, everyone, null)
    return {
      access,
      sending: initialAccessDomains.verified,
      taken: new Map(
        choices.flatMap((c) => (c.coveredBy ? [[c.id, c.coveredBy.name]] : [])),
      ),
    }
  })
  const [typed, setTyped] = React.useState("")
  const [pending, setPending] = React.useState<AccessDomain | null>(null)
  const [displayPending, setDisplayPending] = React.useState<AccessDomain | null>(
    pending,
  )
  if (pending && pending !== displayPending) setDisplayPending(pending)

  const [busy, setBusy] = React.useState<string | null>(null)
  const [inputError, setInputError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)

  /** Only once they say the record is in: a record we just showed cannot be live yet. */
  const [checking, setChecking] = React.useState(false)
  const [isLooking, setIsLooking] = React.useState(false)
  const [notFound, setNotFound] = React.useState<string | null>(null)
  const [lastChecked, setLastChecked] = React.useState<string | null>(null)
  const [addedAt, setAddedAt] = React.useState<string | null>(null)
  const bringStepUp = useBringStepUp()

  const suggestion = emailDomain(email)
  const known = React.useMemo(
    () => (loaded ? new Set(loaded.access.map((d) => d.name)) : new Set<string>()),
    [loaded],
  )
  const sending = React.useMemo(
    () => (loaded ? loaded.sending.filter((name) => !known.has(name)) : []),
    [loaded, known],
  )
  const offerEmail =
    loaded &&
    suggestion &&
    !known.has(suggestion) &&
    !sending.includes(suggestion) &&
    !pending
      ? suggestion
      : null

  const [displayOfferEmail, setDisplayOfferEmail] = React.useState<string | null>(
    offerEmail,
  )
  if (offerEmail && offerEmail !== displayOfferEmail) setDisplayOfferEmail(offerEmail)

  const reloadDomains = React.useCallback(async () => {
    const [team, conns] = await Promise.all([teamAccessDomains(), ssoConnections()])
    const access = team.ok ? team.data.data : []
    const everyone = conns.ok ? conns.data.data : others
    const verified = access.filter((d) => d.status === "verified")
    const choices = domainChoices(verified, everyone, null)
    setLoaded({
      access,
      sending: team.ok ? team.data.verified : [],
      taken: new Map(
        choices.flatMap((c) => (c.coveredBy ? [[c.id, c.coveredBy.name]] : [])),
      ),
    })
  }, [others])

  const attach = React.useCallback(
    async (domain: { id: string; name: string }) => {
      if (!connectionId) return
      setBusy(domain.name)
      setActionError(null)
      setInputError(null)
      const result = await addSsoDomain(connectionId, domain.id)
      setBusy(null)
      if (!result.ok) {
        setActionError(result.error)
        return
      }
      setPending(null)
      onAttached({ joinDomainId: domain.id, name: domain.name, live: true })
      void reloadDomains()
    },
    [connectionId, onAttached, reloadDomains],
  )

  React.useEffect(() => {
    if (!open || !connectionId) return
    if (initialAccessDomains && loaded !== null) return
    let live = true
    void Promise.all([teamAccessDomains(), ssoConnections()]).then(([team, conns]) => {
      if (!live) return
      const access = team.ok ? team.data.data : []
      const everyone = conns.ok ? conns.data.data : others
      const verified = access.filter((d) => d.status === "verified")
      const choices = domainChoices(verified, everyone, null)
      setLoaded({
        access,
        sending: team.ok ? team.data.verified : [],
        taken: new Map(
          choices.flatMap((c) => (c.coveredBy ? [[c.id, c.coveredBy.name]] : [])),
        ),
      })
    })
    return () => {
      live = false
    }
  }, [open, connectionId, others, initialAccessDomains, loaded])

  const waiting = open && checking ? pending : null
  const inFlight = React.useRef(false)
  const look = React.useCallback(
    async (domain: AccessDomain) => {
      if (inFlight.current) return false
      inFlight.current = true
      setIsLooking(true)
      try {
        const verdict = await verifyAccessDomain(domain.id)
        setLastChecked(new Date().toISOString())
        if (!verdict.ok) {
          setNotFound(verdict.error)
          return false
        }
        if (verdict.data.proven) {
          setChecking(false)
          setNotFound(null)
          void attach(domain)
          return true
        }
        setNotFound(
          verdict.data.reason === "unreachable"
            ? "We could not reach your DNS just now. We will keep trying."
            : "We cannot see the record yet. DNS can take a few minutes, so we will keep checking.",
        )
        return false
      } finally {
        inFlight.current = false
        setIsLooking(false)
      }
    },
    [attach],
  )

  React.useEffect(() => {
    if (!waiting) return
    let stopped = false
    const check = async () => {
      if (document.visibilityState !== "visible" || stopped) return
      await look(waiting)
    }
    const timer = setInterval(() => void check(), CHECK_EVERY_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [waiting, look])

  /*
   * ⚠ THE LOOKUP OPENS WITH ITS FIRST ANSWER, NOT BEFORE IT. Opened at the
   * press, it showed a neutral "Checking" for a split second and then turned
   * yellow, because a record added a moment ago is almost never visible yet.
   * The button spins through that first lookup instead; a record that is
   * already there attaches and nothing opens at all.
   */
  async function recordAdded() {
    if (!pending) return
    setBusy("record")
    setNotFound(null)
    setAddedAt(new Date().toISOString())
    try {
      if (!(await look(pending))) {
        setChecking(true)
        bringStepUp()
      }
    } finally {
      setBusy(null)
    }
  }

  async function discard(domain: AccessDomain) {
    const before = loaded
    setActionError(null)
    setInputError(null)
    setLoaded((l) =>
      l ? { ...l, access: l.access.filter((d) => d.id !== domain.id) } : l,
    )
    const removed = await removeAccessDomain(domain.id)
    if (!removed.ok) {
      setLoaded(before)
      setActionError(removed.error)
    } else {
      void reloadDomains()
    }
  }

  function useAnother() {
    setPending(null)
    setChecking(false)
    setNotFound(null)
    setActionError(null)
    setInputError(null)
  }

  const domainCheck = (value: string) =>
    provider === "entra" && isMicrosoftOwnedDomain(value.trim().toLowerCase())
      ? MICROSOFT_OWNED
      : domainProblem(value)

  async function add(rawName: string) {
    const name = rawName.trim().toLowerCase()
    setActionError(null)
    setInputError(null)
    const problem = domainCheck(name)
    if (problem) {
      setInputError(typeof problem === "string" ? problem : problem.message)
      return
    }
    const waitingRow = loaded?.access.find(
      (d) => d.name === name && d.status === "pending",
    )
    if (waitingRow) {
      setPending(waitingRow)
      setTyped("")
      return
    }
    setBusy(name)
    const fromSending = loaded?.sending.includes(name) ?? false
    const added = await addAccessDomain(name, fromSending ? "domains" : "txt")
    if (!added.ok) {
      setBusy(null)
      setInputError(added.error)
      return
    }
    if (fromSending) {
      await attach({ id: added.data.id, name })
      return
    }
    const team = await teamAccessDomains()
    setBusy(null)
    if (team.ok) setLoaded((l) => (l ? { ...l, access: team.data.data } : l))
    const row = team.ok ? team.data.data.find((d) => d.id === added.data.id) : undefined
    if (row) setPending(row)
    setTyped("")
    void reloadDomains()
  }

  if (!loaded) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Looking for your domains
      </p>
    )
  }

  const verified = loaded.access.filter((d) => d.status === "verified")
  const waitingRows = loaded.access.filter(
    (d) => d.status === "pending" && d.id !== pending?.id,
  )
  const hasRows = verified.length > 0 || sending.length > 0 || waitingRows.length > 0

  // ⚠ THE LOOKUP SHOWS A TIME FROM THE PRESS ON, so its line count never
  // changes when the first answer arrives and nothing under it drops.
  const checkedAt = lastChecked ?? addedAt ?? undefined

  const notice: JourneyNotice | null = checking
    ? {
        tone: notFound ? "warning" : "neutral",
        title: "Looking for the record",
        body:
          notFound ??
          "Checking your DNS provider for the TXT record. Propagation is usually minutes.",
        busy: isLooking || busy === "record",
      }
    : null

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        People with an address on this domain will sign in through your provider.
      </p>
      {provider === "entra" && (
        <p className="text-xs text-muted-foreground">
          Microsoft owns onmicrosoft.com domains, so they cannot be used here. Add your
          company&apos;s domain in Entra and move your members&apos; logins to it.
        </p>
      )}

      <Reveal show={hasRows} spacing="">
        <ul className="divide-y divide-border rounded-2xl border border-border">
          {verified.map((d) => {
            const usedBy = loaded.taken.get(d.id)
            return (
              <li
                key={d.id}
                className="flex min-h-13 items-center gap-3 px-4 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                {usedBy ? (
                  <span className="truncate text-xs text-muted-foreground">
                    Used by {usedBy}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === d.name}
                    disabled={busy !== null}
                    onClick={() => void attach(d)}
                  >
                    Use this
                  </Button>
                )}
              </li>
            )
          })}
          <AnimatePresence initial={false}>
            {waitingRows.map((d) => (
              <motion.li
                key={d.id}
                layout="position"
                className="group relative"
                // ⚠ CLIPPED ONLY WHILE IT GROWS OR SHRINKS: the remove X hangs
                // outside the row on hover, and a permanent clip hid it.
                initial={{ opacity: 0, height: 0, overflow: "hidden" }}
                animate={{
                  opacity: 1,
                  height: "auto",
                  transitionEnd: { overflow: "visible" },
                }}
                exit={{ opacity: 0, height: 0, overflow: "hidden" }}
                transition={motionTokens.spring.smooth}
              >
                <div className="flex min-h-13 items-center gap-3 px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  <span className="text-xs text-muted-foreground">
                    Waiting for its record
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => {
                      setPending(d)
                      setChecking(false)
                      setNotFound(null)
                    }}
                  >
                    Continue
                  </Button>
                  <div className="w-0 shrink-0 overflow-hidden transition-[width] duration-(--duration-dismiss) ease-(--ease-quint-out) group-focus-within:w-11 sm:hidden">
                    <DiscardDomain name={d.name} onClick={() => void discard(d)} />
                  </div>
                </div>
                <div className="pointer-events-none absolute inset-y-0 left-full hidden items-center ps-2 opacity-0 transition-[opacity,translate] duration-(--duration-dismiss) ease-(--ease-quint-out) -translate-x-2 group-focus-within:pointer-events-auto group-focus-within:translate-x-0 group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100 sm:flex">
                  <DiscardDomain name={d.name} onClick={() => void discard(d)} />
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
          {sending.map((name) => (
            <li
              key={name}
              className="flex min-h-13 items-center gap-3 px-4 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="text-xs text-muted-foreground">Already proven</span>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === name}
                disabled={busy !== null}
                onClick={() => void add(name)}
              >
                Use this
              </Button>
            </li>
          ))}
        </ul>
      </Reveal>

      <Reveal show={!pending} spacing="pt-3">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void add(typed)
          }}
        >
          <ValidatedInput
            id="domain"
            label="Add a domain"
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value)
              setInputError(null)
            }}
            // ⚠ ENTER ON A WRONG DOMAIN SAYS WHY. Add is disabled until the
            // domain is valid, and a disabled button makes Enter do nothing.
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !typed.trim()) return
              const problem = domainCheck(typed)
              if (problem)
                setInputError(typeof problem === "string" ? problem : problem.message)
            }}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            check={domainCheck}
            refused={inputError ?? undefined}
            required="Enter your domain."
            reserveHint
            adornment={
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                loading={busy === typed.trim().toLowerCase() && typed !== ""}
                disabled={!typed.trim() || busy !== null || domainCheck(typed) !== null}
              >
                Add
              </Button>
            }
          />
        </form>
        <Reveal show={Boolean(offerEmail)} spacing="mt-2">
          {displayOfferEmail && (
            <p className="text-sm text-muted-foreground">
              Your email uses {displayOfferEmail}.{" "}
              <button
                type="button"
                className="text-foreground underline underline-offset-4"
                disabled={busy !== null}
                onClick={() => void add(displayOfferEmail)}
              >
                Use it
              </button>
            </p>
          )}
        </Reveal>
      </Reveal>

      <Reveal show={pending !== null} spacing="pt-1">
        {displayPending && (
          <div className="space-y-3 rounded-2xl border border-border p-4">
            <div>
              <p className="text-sm font-medium">Prove you own {displayPending.name}</p>
              <p className="text-sm text-muted-foreground">
                Add this TXT record at your DNS provider.
              </p>
            </div>
            <div className="grid gap-2">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Name</p>
                <CopyField value={displayPending.txt.name} />
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Value</p>
                <CopyField value={displayPending.txt.value} />
              </div>
            </div>
            <Reveal show={checking} spacing="pt-3">
              <Journey
                title="Verification"
                notice={notice}
                steps={[
                  {
                    key: "added",
                    label: "Record added",
                    icon: "records",
                    tone: "neutral",
                    state: "done",
                    ...(addedAt ? { at: addedAt } : {}),
                  },
                  {
                    key: "checking",
                    label: "Looking it up",
                    icon: "records",
                    tone: notFound ? "warning" : "neutral",
                    state: "current",
                    note: notFound ? "Not found yet" : "Checking",
                    ...(checkedAt ? { at: checkedAt } : {}),
                  },
                ]}
              />
            </Reveal>
            <div className="flex min-h-10 items-center justify-between gap-3 pt-1">
              <AnimatePresence initial={false}>
                {!checking ? (
                  <motion.div
                    key="record-added"
                    exit={{ opacity: 0 }}
                    transition={{ duration: motionTokens.duration.fast }}
                  >
                    <Button
                      loading={busy === "record"}
                      onClick={() => void recordAdded()}
                    >
                      I&rsquo;ve added the record
                    </Button>
                  </motion.div>
                ) : (
                  <span key="spacer" />
                )}
              </AnimatePresence>
              <button
                type="button"
                className="text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
                onClick={useAnother}
              >
                Use another domain
              </button>
            </div>
          </div>
        )}
      </Reveal>

      <InlineError message={actionError} />
    </div>
  )
}
