"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Alert } from "@repo/ui/components/alert/alert"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { StateButton } from "@repo/ui/components/i10/state-button"
import { ValidatedInput } from "@repo/ui/components/i10/validated-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { PanelError } from "@/components/panel-error"
import { addMailboxAlias, removeMailboxAlias } from "@/lib/actions"
import {
  addAliasBlock,
  ALIAS_LIMIT,
  aliasAddress,
  aliasCountLine,
  aliasLocalProblem,
  aliasRefusal,
  aliasRefusalTitle,
  aliasSourceNote,
  consoleAliasCount,
  defaultAliasDomain,
  MAX_ALIAS_LOCAL_PART,
  NO_ALIASES,
  type MailboxAliasList,
} from "@/lib/mailbox-aliases"
import type { ConsoleMailbox } from "@/lib/mailbox-view"
import { useOutcome } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"
import { useStepUp } from "@/lib/step-up"
import { toastDone } from "@/lib/toast"

const ADD_BLOCK_ID = "mailbox-alias-add-block"

/**
 * The other addresses that deliver to one mailbox: who added each, and for an
 * owner or admin the two things that can be done about it.
 *
 * ⚠ THE LIST IS THE PAGE'S, NOT THIS COMPONENT'S. It arrives as a prop from the
 * server render, and an add or a remove is a server action whose response already
 * carries the re-rendered page (see `run` in lib/actions.ts), so the rows change in
 * place with no second fetch and no local copy to drift from it.
 *
 * ⚠ A MEMBER SEES THE SAME LIST WITHOUT THE BUTTONS, as the rest of the page does:
 * the API answers a member only for their own mailbox, and every button is still
 * behind the API's own role check and a fresh session.
 *
 * ⚠ ONLY AN ALIAS AN ADMIN ADDED CAN BE REMOVED HERE, and the others say why in
 * their own line instead of offering a button the API would refuse. Clerk's and a
 * directory's would be put straight back by the next sync, so the removal would look
 * done and not be.
 *
 * ⚠ REMOVING STAYS OPEN DURING A DELETION GRACE, ADDING DOES NOT: the API's rule
 * (`mailbox_deleting`), said before the click as the reason beside the disabled
 * button rather than after it as a refusal.
 */
export function MailboxAliases({
  mailbox,
  list,
  domains,
  isAdmin,
}: {
  mailbox: ConsoleMailbox
  /** Null where the list could not be read: the section says so, the page still renders. */
  list: MailboxAliasList | null
  /** The domains this workspace hosts mailboxes on. Admins only. */
  domains: readonly string[]
  isAdmin: boolean
}) {
  const [adding, setAdding] = React.useState(false)
  const [removal, setRemoval] = React.useState<{ alias: string; open: boolean } | null>(
    null,
  )

  const aliases = list ? list.data : NO_ALIASES
  const limit = list ? list.limit : ALIAS_LIMIT
  const added = consoleAliasCount(aliases)
  const block =
    isAdmin && list
      ? addAliasBlock({ status: mailbox.status, added, limit, domains })
      : null
  // ⚠ NOT WHILE THE REASON IS SHOWN: at the limit the reason already says it.
  const countLine = isAdmin && list && !block ? aliasCountLine(added, limit) : null

  return (
    <Section>
      <div className="flex items-start justify-between gap-4">
        <div>
          <SectionTitle>Aliases</SectionTitle>
          <SectionDescription>
            Mail sent to any of these addresses arrives in this mailbox.
          </SectionDescription>
        </div>
        {isAdmin && list && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            disabled={block !== null}
            aria-describedby={block ? ADD_BLOCK_ID : undefined}
            onClick={() => setAdding(true)}
          >
            <Plus aria-hidden="true" />
            Add alias
          </Button>
        )}
      </div>
      <SectionContent>
        {!list ? (
          <PanelError
            title="Could not load the aliases"
            message="Reload the page to try again."
          />
        ) : aliases.length === 0 ? (
          <div className="rounded-2xl border bg-card px-4 py-6">
            <p className="text-sm text-muted-foreground">
              {isAdmin
                ? "No aliases yet. Add one to receive mail at another address."
                : "No aliases yet."}
            </p>
          </div>
        ) : (
          <ul className="divide-y rounded-2xl border bg-card">
            {aliases.map((alias) => (
              <li
                key={alias.address}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate font-mono text-sm">{alias.address}</p>
                  <p className="text-xs text-muted-foreground">
                    {aliasSourceNote(alias.source)}
                  </p>
                </div>
                {isAdmin && alias.source === "console" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    aria-label={`Remove ${alias.address}`}
                    onClick={() => setRemoval({ alias: alias.address, open: true })}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {(block || countLine) && (
          <div className="mt-3 space-y-1 text-xs text-muted-foreground">
            {block && <p id={ADD_BLOCK_ID}>{block}</p>}
            {countLine && <p>{countLine}</p>}
          </div>
        )}
      </SectionContent>

      {isAdmin && (
        <AddAliasDialog
          mailbox={mailbox}
          domains={domains}
          open={adding}
          onOpenChange={setAdding}
        />
      )}
      {/* ⚠ CLOSING KEEPS THE REQUEST, so the dialog plays its exit with its content. */}
      {isAdmin && removal && (
        <RemoveAliasDialog
          mailbox={mailbox.address}
          alias={removal.alias}
          open={removal.open}
          onOpenChange={(open) => setRemoval((r) => (r ? { ...r, open } : r))}
        />
      )}
    </Section>
  )
}

/**
 * The part before the @ and the domain, which become one address.
 *
 * ⚠ THE DOMAIN PICKER IS HIDDEN WHEN THERE IS ONE CHOICE, and the hint under the
 * address says where it ends, so nothing is asked that has only one answer. It
 * starts on the mailbox's own domain, since most aliases are another spelling of
 * the same name.
 *
 * ⚠ THE CHECK HERE IS THE EARLY, FRIENDLY HALF. Whether the address is free, and
 * whether the domain is still the workspace's, are the API's, and its answer is
 * said in the dialog as an alert: it sits beside the field it is about, the dialog
 * stays open with everything typed, and it is announced.
 */
function AddAliasDialog({
  mailbox,
  domains,
  open,
  onOpenChange,
}: {
  mailbox: ConsoleMailbox
  domains: readonly string[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const stepUp = useStepUp()
  const outcome = useOutcome()
  const [local, setLocal] = React.useState("")
  const [domain, setDomain] = React.useState(
    defaultAliasDomain(domains, mailbox.domain),
  )
  const [refusal, setRefusal] = React.useState<string | null>(null)

  useResetOnOpen(open, () => {
    outcome.reset()
    setLocal("")
    setDomain(defaultAliasDomain(domains, mailbox.domain))
    setRefusal(null)
  })

  const activeDomain = domains.includes(domain)
    ? domain
    : defaultAliasDomain(domains, mailbox.domain)
  const ready =
    local.trim() !== "" && aliasLocalProblem(local) === null && activeDomain !== ""
  const busy = outcome.state !== "idle"

  /** Any edit retires the last refusal: it was about what was there before. */
  function edit<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setRefusal(null)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !ready) return
    setRefusal(null)

    await outcome.run(
      async () => {
        if (!(await stepUp())) return false
        const address = aliasAddress(local, activeDomain)
        const result = await addMailboxAlias(mailbox.address, address)
        if (!result.ok) {
          setRefusal(aliasRefusal(result, "add"))
          return false
        }
        toastDone(
          "Alias added",
          `Mail to ${address} now arrives in ${mailbox.address}.`,
        )
        return true
      },
      () => onOpenChange(false),
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={outcome.state === "pending" ? () => {} : onOpenChange}
    >
      <DialogContent
        title="Add alias"
        description={`Another address that delivers to ${mailbox.address}.`}
        style={{ width: "min(calc(100vw - 2rem), 448px)" }}
      >
        <form onSubmit={submit} {...outcome.formProps}>
          <div className="space-y-4 py-4">
            <ValidatedInput
              id="mailbox-alias-local"
              label="Alias"
              value={local}
              onChange={(event) => edit(setLocal)(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={MAX_ALIAS_LOCAL_PART + 16}
              check={aliasLocalProblem}
              required="Enter the part before the @, like sales."
              hint={
                local.trim()
                  ? `The alias will be ${aliasAddress(local, activeDomain)}`
                  : `The part before the @, like sales. It ends in @${activeDomain}.`
              }
            />

            {domains.length > 1 && (
              <MorphSelect
                label="Domain"
                items={domains.map((value) => ({ value, label: value }))}
                value={activeDomain}
                onValueChange={(value) => edit(setDomain)(value)}
                disabled={busy}
              />
            )}

            {refusal && (
              <Alert tone="danger" title={aliasRefusalTitle("add")}>
                {refusal}
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={outcome.state === "pending"}
            >
              Cancel
            </Button>
            <StateButton
              type="submit"
              state={outcome.state}
              pendingLabel="Add alias"
              doneLabel="Added"
              disabled={!ready}
            >
              Add alias
            </StateButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Letting go of an alias, after one confirmation that says what stops.
 *
 * ⚠ THE STEP-UP COMES BEFORE THE CALL AND ITS DECLINE LEAVES THE DIALOG OPEN WITH
 * NOTHING DONE, as in the lifecycle dialogs. A refusal is said in the dialog; only
 * a success is a toast.
 */
function RemoveAliasDialog({
  mailbox,
  alias,
  open,
  onOpenChange,
}: {
  mailbox: string
  alias: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const stepUp = useStepUp()
  const [refusal, setRefusal] = React.useState<string | null>(null)
  useResetOnOpen(open, () => setRefusal(null))

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Remove ${alias}?`}
      description={`Mail sent to this address stops arriving in ${mailbox}.`}
      confirmLabel="Remove alias"
      doneLabel="Removed"
      onConfirm={async () => {
        setRefusal(null)
        if (!(await stepUp())) return false
        const result = await removeMailboxAlias(mailbox, alias)
        if (!result.ok) {
          setRefusal(aliasRefusal(result, "remove"))
          return false
        }
        toastDone("Alias removed", `${alias} no longer delivers to ${mailbox}.`)
        return true
      }}
    >
      {refusal && (
        <Alert tone="danger" title={aliasRefusalTitle("remove")}>
          {refusal}
        </Alert>
      )}
    </ConfirmDialog>
  )
}
