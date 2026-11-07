"use client"

import * as React from "react"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { Reveal } from "@repo/ui/components/i10/reveal"
import { createSetupLink } from "@/lib/sso-actions"
import { InlineError } from "./inline-error"

const LINK_LIFETIME_HOURS = 24 * 7

/** One numbered action in a provider's guide. */
export function Numbered({
  n,
  title,
  children,
}: {
  n: number
  title: string
  children: React.ReactNode
}) {
  return (
    <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3">
      <span className="pt-px text-sm tabular-nums text-muted-foreground">{n}</span>
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </li>
  )
}

export function SwitchProtocol({
  to,
  disabled,
  onClick,
}: {
  to: "OIDC" | "SAML"
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <div className="flex justify-end">
      <button
        type="button"
        className="text-xs text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
        disabled={disabled}
        onClick={onClick}
      >
        Use {to} instead
      </button>
    </div>
  )
}

/** Hands the provider's half to whoever runs it. */
export function SetupLinkCard({
  connectionId,
  providerLabel,
  authOrigin,
}: {
  connectionId: string
  providerLabel: string
  authOrigin: string | null
}) {
  const [link, setLink] = React.useState<string | null>(null)
  const [displayLink, setDisplayLink] = React.useState<string | null>(link)
  if (link && link !== displayLink) setDisplayLink(link)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function make() {
    setBusy(true)
    setError(null)
    const made = await createSetupLink(connectionId, {
      expiresInHours: LINK_LIFETIME_HOURS,
      contactEmail: null,
    })
    setBusy(false)
    if (!made.ok) {
      setError(made.error)
      return
    }
    setLink(`${authOrigin ?? ""}/sso/setup#token=${made.data.token}`)
  }

  return (
    <div className="rounded-2xl border border-border px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Someone else manages {providerLabel}? Send them this part.
        </p>
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          disabled={link !== null}
          onClick={() => void make()}
        >
          Create a setup link
        </Button>
      </div>
      <InlineError message={error} />
      <Reveal show={link !== null} spacing="pt-3">
        {displayLink && (
          <div className="space-y-1.5">
            <CopyField value={displayLink} />
            <p className="text-xs text-muted-foreground">
              Works for 7 days. It is only shown once.
            </p>
          </div>
        )}
      </Reveal>
    </div>
  )
}
