"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { motionTokens } from "@repo/ui/components/lib/motion-tokens"
import { Spinner } from "@repo/ui/components/i10/spinner"
import type { IdpChoice } from "@/lib/sso-setup-choices"
import { recommendedProtocol } from "@/lib/sso-setup-flow"
import { IdpMark } from "../idp-mark"

export type ProviderPick = {
  idp: string
  label: string
  protocol: "oidc" | "saml"
}

function Tile({
  mark,
  label,
  pending,
  disabled,
  onClick,
}: {
  mark: string
  label: string
  pending: boolean
  disabled: boolean
  onClick: () => void
}) {
  const reduced = useReducedMotion() ?? false
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      transition={motionTokens.spring.snappy}
      className="flex items-center gap-3 rounded-2xl border border-border p-3 text-left text-sm font-medium transition-[background-color,border-color,opacity] duration-150 hover:border-foreground/25 hover:bg-muted/50 disabled:cursor-default disabled:hover:border-border disabled:hover:bg-transparent [&:disabled:not([data-pending])]:opacity-50"
      data-pending={pending || undefined}
    >
      <AnimatePresence mode="wait" initial={false}>
        {pending ? (
          <motion.span
            key="spinner"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduced ? undefined : { opacity: 0 }}
            transition={
              reduced
                ? { duration: 0 }
                : {
                    duration: motionTokens.duration.fast,
                    ease: motionTokens.ease.standard,
                  }
            }
            className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border"
          >
            <Spinner />
          </motion.span>
        ) : (
          <motion.span
            key="mark"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduced ? undefined : { opacity: 0 }}
            transition={
              reduced
                ? { duration: 0 }
                : {
                    duration: motionTokens.duration.fast,
                    ease: motionTokens.ease.standard,
                  }
            }
          >
            <IdpMark idp={mark} />
          </motion.span>
        )}
      </AnimatePresence>
      <span className="min-w-0 leading-snug">{label}</span>
    </motion.button>
  )
}

export function ProviderStep({
  choices,
  pending,
  onPick,
}: {
  choices: IdpChoice[]
  /** The tile being created, while the connection is made. */
  pending: string | null
  onPick: (pick: ProviderPick) => void
}) {
  const named = choices.filter((c) => c.idp !== "generic")
  const generic = choices.find((c) => c.idp === "generic")
  const busy = pending !== null

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        {named.map((c) => (
          <Tile
            key={c.idp}
            mark={c.idp}
            label={c.label}
            pending={pending === c.idp}
            disabled={busy}
            onClick={() =>
              onPick({
                idp: c.idp,
                label: c.label,
                protocol: recommendedProtocol(c.protocols),
              })
            }
          />
        ))}
      </div>
      {generic && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or use any other provider
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {generic.protocols.map((protocol) => (
              <Tile
                key={protocol}
                mark={protocol}
                label={protocol === "saml" ? "Custom SAML" : "Custom OIDC"}
                pending={pending === `generic-${protocol}`}
                disabled={busy}
                onClick={() =>
                  onPick({
                    idp: "generic",
                    label: protocol === "saml" ? "Custom SAML" : "Custom OIDC",
                    protocol,
                  })
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
