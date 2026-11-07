"use client"

import { useEffect, useRef, useState } from "react"
import { OrganizationProfile, useAuth, useClerk } from "@clerk/nextjs"
import { ensureProbeOrg, type ProbeState } from "./actions"

type Mount = (node: HTMLDivElement, props?: Record<string, unknown>) => void
type Unmount = (node: HTMLDivElement) => void

/**
 * Mounts one of Clerk's internal components by name, if the clerk-js loaded at
 * runtime has it. They are not exported as React components in our SDK
 * version, so feature-detect on the instance instead of trusting the types.
 */
function InternalMount({ name }: { name: "ConfigureSSO" | "ConfigureDirectorySync" }) {
  const clerk = useClerk() as unknown as Record<string, unknown>
  const node = useRef<HTMLDivElement>(null)
  const mount = clerk[`__internal_mount${name}`] as Mount | undefined
  const unmount = clerk[`__internal_unmount${name}`] as Unmount | undefined

  useEffect(() => {
    const el = node.current
    if (!el || !mount) return
    mount.call(clerk, el, {})
    return () => unmount?.call(clerk, el)
  }, [clerk, mount, unmount])

  if (!mount)
    return <p className="text-sm text-muted-foreground">This clerk-js has no {name}.</p>
  return <div ref={node} />
}

const TABS = ["OrganizationProfile", "ConfigureSSO", "ConfigureDirectorySync"] as const

export function ClerkProbe() {
  const { orgId } = useAuth()
  const clerk = useClerk()
  const [state, setState] = useState<ProbeState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<(typeof TABS)[number]>("OrganizationProfile")

  async function prepare() {
    setError(null)
    try {
      const next = await ensureProbeOrg()
      // Clerk's components act on the ACTIVE organization.
      if (orgId !== next.orgId) await clerk.setActive({ organization: next.orgId })
      setState(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const active = state && orgId === state.orgId

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-medium">Clerk org-component probe</h1>
        <p className="text-sm text-muted-foreground">
          Dev instance only. Prepare makes you Clerk admin of the probe organization
          (our roles webhook demotes you again while the tunnel is up, so press it
          before each look) and turns on its self-serve SSO and directory sync.
        </p>
        <div className="flex gap-2">
          <button
            className="rounded-md border px-3 py-1.5 text-sm"
            onClick={() => void prepare()}
          >
            Prepare
          </button>
          {TABS.map((t) => (
            <button
              key={t}
              className={`rounded-md px-3 py-1.5 text-sm ${tab === t ? "bg-accent" : ""}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </header>

      {active ? (
        <section key={tab}>
          {tab === "OrganizationProfile" ? (
            <OrganizationProfile routing="hash" />
          ) : (
            <InternalMount name={tab} />
          )}
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          Press Prepare to activate the probe organization.
        </p>
      )}

      {state && (
        <details>
          <summary className="cursor-pointer text-sm">
            Backend view of the probe organization
          </summary>
          <pre className="overflow-x-auto text-xs">
            {JSON.stringify(state, null, 2)}
          </pre>
        </details>
      )}
    </main>
  )
}
