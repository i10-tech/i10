"use client"

import * as React from "react"
import { Plus } from "lucide-react"
import { Alert } from "@repo/ui/components/alert/alert"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { StateButton } from "@repo/ui/components/i10/state-button"
import { ValidatedInput } from "@repo/ui/components/i10/validated-field"
import { MorphSelect } from "@repo/ui/components/morph-select/morph-select"
import { TeamInboxMembersField } from "@/components/team-inbox-members-field"
import { createTeamInbox } from "@/lib/actions"
import { localPartProblem } from "@/lib/mailbox-create"
import { useOutcome } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"
import { useStepUp } from "@/lib/step-up"
import {
  membersProblem,
  refusalTitle,
  teamInboxRefusal,
  type Candidate,
} from "@/lib/team-inbox"
import { toastDone } from "@/lib/toast"

/**
 * Creating a team inbox: an owner or admin only, behind a fresh session.
 *
 * ⚠ EVERY REFUSAL IS SAID IN THE DIALOG AS AN ALERT, NOT IN A TOAST, as in
 * `CreateMailbox`: the sentence names the address that is taken or the person to
 * take out, so it belongs beside the fields it is about, with everything typed
 * still there, and it is announced. Only a success is a toast.
 *
 * ⚠ THE CANDIDATES ARE MAILBOXES, NOT CLERK MEMBERS. A team inbox member is a
 * mailbox address (see lib/team-inbox.ts), so the page reads the workspace's
 * mailboxes once and passes the usable ones down. That also means the picker
 * works in preview and needs no Clerk hook.
 */
export function CreateTeamInbox({
  domains,
  candidates,
}: {
  /** Domains this workspace hosts mailboxes on: hosting on and proven. */
  domains: string[]
  candidates: readonly Candidate[]
}) {
  const [open, setOpen] = React.useState(false)
  const stepUp = useStepUp()
  const outcome = useOutcome()

  const [local, setLocal] = React.useState("")
  const [domain, setDomain] = React.useState(domains[0] ?? "")
  const [name, setName] = React.useState("")
  const [members, setMembers] = React.useState<string[]>([])
  const [refusal, setRefusal] = React.useState<string | null>(null)

  useResetOnOpen(open, () => {
    outcome.reset()
    setLocal("")
    setDomain(domains[0] ?? "")
    setName("")
    setMembers([])
    setRefusal(null)
  })

  const activeDomain = domains.includes(domain) ? domain : (domains[0] ?? "")
  const localOk = local.trim() !== "" && localPartProblem(local) === null
  const ready = localOk && membersProblem(members) === null

  /** Any edit retires the last refusal: it was about what was there before. */
  function edit<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setRefusal(null)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (outcome.state !== "idle" || !ready) return
    setRefusal(null)

    await outcome.run(
      async () => {
        if (!(await stepUp())) return false

        const address = `${local.trim().toLowerCase()}@${activeDomain}`
        const display = name.trim()
        const result = await createTeamInbox({
          address,
          ...(display ? { display_name: display } : {}),
          members,
        })
        if (!result.ok) {
          setRefusal(teamInboxRefusal(result, "create"))
          return false
        }
        toastDone("Team inbox created", `${result.data.address} is ready to use.`)
        return true
      },
      () => setOpen(false),
    )
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        Create team inbox
      </Button>
      <Dialog
        open={open}
        onOpenChange={outcome.state === "pending" ? () => {} : setOpen}
      >
        <DialogContent
          title="Create team inbox"
          description={
            domains.length === 0
              ? "A team inbox needs a domain to live on."
              : "A shared address that several people read and reply from in their own mail apps."
          }
          style={{ width: "min(calc(100vw - 2rem), 448px)" }}
        >
          {domains.length === 0 ? (
            <>
              <p className="py-4 text-sm text-muted-foreground">
                Set up a domain for mailboxes first: add the domain, then turn on
                mailbox hosting for it on its page.
              </p>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Close
                </Button>
                <ButtonLink href="/domains" size="md">
                  Go to domains
                </ButtonLink>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={submit} {...outcome.formProps}>
              <div className="space-y-4 py-4">
                <ValidatedInput
                  id="team-inbox-local-part"
                  label="Address"
                  value={local}
                  onChange={(event) => edit(setLocal)(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={80}
                  check={localPartProblem}
                  required="Enter the part before the @, like support."
                  hint={
                    local.trim()
                      ? `The address will be ${local.trim().toLowerCase()}@${activeDomain}`
                      : `The part before the @, like support. It ends in @${activeDomain}.`
                  }
                />

                {domains.length > 1 && (
                  <MorphSelect
                    label="Domain"
                    items={domains.map((value) => ({ value, label: value }))}
                    value={activeDomain}
                    onValueChange={(value) => edit(setDomain)(value)}
                    disabled={outcome.state !== "idle"}
                  />
                )}

                <ValidatedInput
                  id="team-inbox-display-name"
                  label="Display name (optional)"
                  value={name}
                  onChange={(event) => edit(setName)(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={255}
                  hint="Shown in mail apps. Leave it empty to use the address."
                />

                <TeamInboxMembersField
                  candidates={candidates}
                  value={members}
                  onChange={edit(setMembers)}
                  disabled={outcome.state !== "idle"}
                />

                {refusal && (
                  <Alert tone="danger" title={refusalTitle("create")}>
                    {refusal}
                  </Alert>
                )}
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  disabled={outcome.state === "pending"}
                >
                  Cancel
                </Button>
                <StateButton
                  type="submit"
                  state={outcome.state}
                  pendingLabel="Create team inbox"
                  doneLabel="Created"
                  disabled={!ready}
                >
                  Create team inbox
                </StateButton>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
