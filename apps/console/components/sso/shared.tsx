"use client"

import * as React from "react"
import { Badge, type BadgeTone } from "@repo/ui/components/badge/badge"
import { Button } from "@repo/ui/components/button/button"
import { CopyField } from "@repo/ui/components/i10/copy-field"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { Switch } from "@repo/ui/components/i10/switch"
import type { ActionResult } from "@/lib/actions"
import { useStepUp } from "@/lib/step-up"
import { toastFailure } from "@/lib/toast"
import type { SsoAbilities, SsoEnforcement, SsoStatus } from "@/lib/sso-types"

/**
 * The small pieces every SSO screen shares (#340).
 */

export const STATUS_LABEL: Record<SsoStatus, string> = {
  draft: "Draft",
  testing: "Testing",
  active: "Active",
  disabled: "Disabled",
}

const STATUS_TONE: Record<SsoStatus, BadgeTone> = {
  draft: "neutral",
  testing: "info",
  active: "success",
  disabled: "warning",
}

export function StatusBadge({ status }: { status: SsoStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} size="sm">
      {STATUS_LABEL[status]}
    </Badge>
  )
}

export const ENFORCEMENT_LABEL: Record<SsoEnforcement, string> = {
  off: "Off",
  optional: "Optional",
  required_domain: "Required for the domain",
  required_all: "Required for everyone",
}

export const ENFORCEMENT_HELP: Record<SsoEnforcement, string> = {
  off: "Nobody is offered this connection at sign-in.",
  optional:
    "People at the connection's domains can choose it beside the usual ways in. Nothing is enforced.",
  required_domain:
    "Anyone with a verified address at the connection's domains must sign in through it. Everyone else is unaffected.",
  required_all:
    "Every member of this workspace must sign in through it, whatever their address.",
}

/**
 * Asks for step-up when the route needs it, runs the action, and says the API's
 * own words on a refusal. Returns the data, or null when the person declined
 * the prompt or the call failed - the caller does nothing more in either case.
 *
 * ⚠ THE STEP-UP IS ASKED FIRST, THEN THE ACTION: the API refuses a stale
 * session with Clerk's hint and the dialog lives in the browser. The API stays
 * the guard; this only moves the question to where it can be answered.
 */
export function useSsoCall() {
  const stepUp = useStepUp()
  return React.useCallback(
    async <T,>(
      fn: () => Promise<ActionResult<T>>,
      options: { stepUp?: boolean; title?: string } = {},
    ): Promise<T | null> => {
      if (options.stepUp !== false && !(await stepUp())) return null
      const result = await fn()
      if (!result.ok) {
        toastFailure(result, options.title ? { title: options.title } : {})
        return null
      }
      return result.data
    },
    [stepUp],
  )
}

/**
 * The same step-up, but the outcome comes back untouched and nothing is
 * toasted: for a caller that reads a particular refusal itself (the IP
 * allowlist's `would_lock_out`). Null when the person declined the prompt.
 */
export function useSsoAttempt() {
  const stepUp = useStepUp()
  return React.useCallback(
    async <T,>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T> | null> =>
      (await stepUp()) ? fn() : null,
    [stepUp],
  )
}

/** A value read once on mount through an action, with a way to set it from a write's answer. */
export function useRemote<T>(load: () => Promise<ActionResult<T>>) {
  const [data, setData] = React.useState<T | null>(null)
  const [failed, setFailed] = React.useState<string | null>(null)
  const loader = React.useRef(load)
  React.useEffect(() => {
    loader.current = load
  })

  const reload = React.useCallback(async () => {
    const result = await loader.current()
    if (result.ok) {
      setData(result.data)
      setFailed(null)
    } else setFailed(result.error)
  }, [])

  React.useEffect(() => {
    void reload()
  }, [reload])

  return { data, setData, failed, reload }
}

/** A titled block of a connection's page: what it decides, then its controls. */
export function Block({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <section className="border-b py-6 first:pt-0 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{title}</h2>
          {description && (
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {children && <div className="mt-4 space-y-3">{children}</div>}
    </section>
  )
}

/** One labelled value with a copy button. */
export function Value({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <CopyField value={value} />
    </div>
  )
}

/**
 * Why a control is unavailable to this person, in words, beside the control.
 * ⚠ HIDING IT WOULD LEAVE AN ADMIN WONDERING WHERE IT WENT; the API refuses
 * the same move regardless.
 */
export function OwnerNote({ abilities }: { abilities: SsoAbilities }) {
  if (abilities.owner) return null
  return (
    <p className="text-xs text-muted-foreground">
      Only a workspace owner can do this on a live connection. Ask an owner.
    </p>
  )
}

/**
 * A secret the API just made, shown once.
 *
 * ⚠ THE ONLY COPY. It lives in this dialog's props and nowhere else: closing
 * it drops the value, the page keeps no copy, and no route returns it again.
 */
export function ShownOnce({
  open,
  title,
  description,
  fields,
  onClose,
}: {
  open: boolean
  title: string
  description: string
  fields: { label: string; value: string }[]
  onClose: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={title}
        description={description}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        style={{ width: "min(calc(100vw - 2rem), 512px)" }}
      >
        <div className="space-y-3 py-4">
          {fields.map((field) => (
            <Value key={field.label} label={field.label} value={field.value} />
          ))}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>I have stored it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Loading({ failed }: { failed: string | null }) {
  return <p className="py-2 text-sm text-muted-foreground">{failed ?? "Loading…"}</p>
}

/** A switch with its label and what it decides. */
export function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  const id = React.useId()
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block max-w-prose text-sm text-muted-foreground">
          {description}
        </span>
      </label>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  )
}

/** On a live connection its trust settings are an owner's (sso.md 2.14). */
export function isLocked(
  connection: { status: SsoStatus },
  abilities: SsoAbilities,
): boolean {
  return (
    (connection.status === "active" || connection.status === "disabled") &&
    !abilities.owner
  )
}
