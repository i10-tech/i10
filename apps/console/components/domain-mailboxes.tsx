"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check, Circle } from "lucide-react"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@repo/ui/components/i10/field"
import { Switch } from "@repo/ui/components/i10/switch"
import { Spinner } from "@repo/ui/components/i10/spinner"
import {
  MorphSelect,
  type MorphSelectItem,
  type MorphSelectOption,
} from "@repo/ui/components/morph-select/morph-select"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { setDomainCatchAll, setDomainMailboxes } from "@/lib/actions"
import { useStepUp } from "@/lib/step-up"
import { toastDone, toastError, toastFailure, type Failure } from "@/lib/toast"
import type { DomainMailboxes as DomainMailboxesType } from "@/lib/types"

export interface CatchAllAccount {
  address: string
  display_name: string | null
}

export function DomainMailboxes({
  domainId,
  domainName,
  mailboxes,
  canManage = true,
  initialMailboxes = [],
  initialTeamInboxes = [],
}: {
  domainId: string
  domainName: string
  mailboxes?: DomainMailboxesType
  canManage?: boolean
  initialMailboxes?: CatchAllAccount[]
  initialTeamInboxes?: CatchAllAccount[]
}) {
  const router = useRouter()
  const stepUp = useStepUp()

  const [values, setValues] = React.useState<DomainMailboxesType>(() => ({
    enabled: mailboxes?.enabled ?? false,
    owned: mailboxes?.owned ?? true,
    sending: mailboxes?.sending ?? true,
    catch_all: mailboxes?.catch_all ?? null,
    count: mailboxes?.count ?? 0,
  }))

  const [stalwart, setStalwart] = React.useState<
    "synced" | "pending" | "unmanaged" | null
  >(null)
  const [saving, setSaving] = React.useState<"hosting" | "catch-all" | null>(null)
  const [confirmingOff, setConfirmingOff] = React.useState(false)

  const [prevMailboxes, setPrevMailboxes] = React.useState(mailboxes)
  if (mailboxes !== prevMailboxes) {
    setPrevMailboxes(mailboxes)
    if (mailboxes) {
      setValues({
        enabled: mailboxes.enabled,
        owned: mailboxes.owned,
        sending: mailboxes.sending,
        catch_all: mailboxes.catch_all,
        count: mailboxes.count,
      })
    }
  }

  function handleHostingError(result: Failure) {
    if (result.name === "domain_not_held" || result.status === 409) {
      const reason = (result.body as { reason?: string } | undefined)?.reason
      if (reason === "displaced") {
        toastError(
          "Could not host mailboxes",
          "Another workspace proved this domain, so it can't host mailboxes here.",
        )
        return
      }
      if (reason === "unowned") {
        toastError(
          "Prove you own this domain first",
          "Publish the records on the Records tab, then verify the domain.",
        )
        return
      }
    }

    if (result.name === "plan_limit_exceeded" || result.status === 403) {
      if (result.name === "forbidden") {
        toastError(
          "Could not host mailboxes",
          "Only an owner or admin can change this.",
        )
        return
      }
      toastFailure(result, {
        action: {
          label: "See plans",
          onClick: () => router.push("/settings/billing"),
        },
      })
      return
    }

    toastError("Could not update mailbox hosting", result.error)
  }

  async function applyHostingChange(next: boolean): Promise<boolean> {
    if (!(await stepUp())) return false
    const previous = values.enabled
    setValues((v) => ({ ...v, enabled: next }))
    setSaving("hosting")
    const result = await setDomainMailboxes(domainId, next)
    setSaving(null)
    if (!result.ok) {
      setValues((v) => ({ ...v, enabled: previous }))
      handleHostingError(result)
      return false
    }

    setStalwart(result.data.stalwart)
    if (result.data.mailboxes) {
      setValues({
        enabled: result.data.mailboxes.enabled,
        owned: result.data.mailboxes.owned,
        sending: result.data.mailboxes.sending,
        catch_all: result.data.mailboxes.catch_all,
        count: result.data.mailboxes.count,
      })
    }
    toastDone(next ? "Mailbox hosting turned on" : "Mailbox hosting turned off")
    return true
  }

  function handleToggle(next: boolean) {
    if (!canManage) return
    if (!next && values.count > 0) {
      setConfirmingOff(true)
      return
    }
    void applyHostingChange(next)
  }

  async function changeCatchAll(address: string | null) {
    if (!canManage) return
    if (!(await stepUp())) return
    const previous = values.catch_all
    setValues((v) => ({ ...v, catch_all: address }))
    setSaving("catch-all")
    const result = await setDomainCatchAll(domainId, address)
    setSaving(null)
    if (!result.ok) {
      setValues((v) => ({ ...v, catch_all: previous }))
      // Show the API's 422 reason as is
      toastError("Could not set catch-all address", result.error)
      return
    }

    setStalwart(result.data.stalwart)
    if (result.data.mailboxes) {
      setValues({
        enabled: result.data.mailboxes.enabled,
        owned: result.data.mailboxes.owned,
        sending: result.data.mailboxes.sending,
        catch_all: result.data.mailboxes.catch_all,
        count: result.data.mailboxes.count,
      })
    }
    toastDone(address ? "Catch-all address updated" : "Catch-all address cleared")
  }

  const catchAllItems = React.useMemo<MorphSelectItem[]>(() => {
    const loose: MorphSelectOption[] = [{ value: "", label: "Nobody" }]
    const groups: MorphSelectItem[] = [loose[0]!]

    if (initialMailboxes.length > 0) {
      groups.push({
        label: "Mailboxes",
        options: initialMailboxes.map((m) => ({
          value: m.address,
          label: m.address,
          meta: m.display_name ?? undefined,
        })),
      })
    }

    if (initialTeamInboxes.length > 0) {
      groups.push({
        label: "Team inboxes",
        options: initialTeamInboxes.map((t) => ({
          value: t.address,
          label: t.address,
          meta: t.display_name ?? undefined,
        })),
      })
    }

    // Preserve current selection if not in lists
    if (values.catch_all) {
      const exists =
        initialMailboxes.some((m) => m.address === values.catch_all) ||
        initialTeamInboxes.some((t) => t.address === values.catch_all)
      if (!exists) {
        groups.push({
          value: values.catch_all,
          label: values.catch_all,
        })
      }
    }

    return groups
  }, [initialMailboxes, initialTeamInboxes, values.catch_all])

  return (
    <>
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="mailbox-hosting">
              Host mailboxes on this domain
            </FieldLabel>
            <FieldDescription>
              {!canManage
                ? "Only an owner or admin can change this."
                : "Allow this domain to create mailboxes and receive mail."}
            </FieldDescription>
          </FieldContent>
          <Switch
            id="mailbox-hosting"
            checked={values.enabled}
            disabled={!canManage || saving === "hosting"}
            onCheckedChange={handleToggle}
          />
        </Field>

        {values.enabled && (
          <div className="rounded-lg border border-border/40 bg-muted/20 p-3.5">
            <ul className="space-y-2.5">
              <li className="flex items-start gap-2.5">
                {values.owned ? (
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-success"
                    aria-hidden="true"
                  />
                ) : (
                  <Circle
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <span
                  className={
                    values.owned
                      ? "text-sm font-medium"
                      : "text-sm text-muted-foreground"
                  }
                >
                  You own this domain
                </span>
              </li>
              <li className="flex items-start gap-2.5">
                {values.sending ? (
                  <Check
                    className="mt-0.5 size-4 shrink-0 text-success"
                    aria-hidden="true"
                  />
                ) : (
                  <Circle
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <div>
                  <span
                    className={
                      values.sending
                        ? "text-sm font-medium"
                        : "text-sm text-muted-foreground"
                    }
                  >
                    Ready to send
                  </span>
                  {!values.sending && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Mail can arrive, but sending starts once your DNS records verify
                    </p>
                  )}
                </div>
              </li>
              {stalwart === "pending" && (
                <li className="flex items-start gap-2.5">
                  <Spinner
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="text-sm text-muted-foreground">
                    Setting up the mail server, this takes a few minutes
                  </span>
                </li>
              )}
            </ul>
          </div>
        )}

        {values.enabled && (
          <Field>
            <FieldContent>
              <FieldLabel htmlFor="catch-all">
                Send mail for unknown addresses to
              </FieldLabel>
              <FieldDescription>Catch-alls receive a lot of spam.</FieldDescription>
            </FieldContent>
            <div className="pt-1">
              <MorphSelect
                label="Send mail for unknown addresses to"
                hideLabel
                value={values.catch_all ?? ""}
                disabled={!canManage || saving === "catch-all"}
                onValueChange={(val) => void changeCatchAll(val === "" ? null : val)}
                items={catchAllItems}
                searchable="auto"
                searchPlaceholder="Search destinations..."
              />
            </div>
          </Field>
        )}
      </FieldGroup>

      <ConfirmDialog
        open={confirmingOff}
        onOpenChange={setConfirmingOff}
        title={`Stop hosting mailboxes on ${domainName}?`}
        description={`${values.count === 1 ? "Its 1 mailbox stops" : `Its ${values.count} mailboxes stop`} signing in and receiving mail until you turn hosting back on. Their mail is kept.`}
        confirmLabel="Stop hosting"
        doneLabel="Turned off"
        onConfirm={async () => {
          return await applyHostingChange(false)
        }}
      />
    </>
  )
}
