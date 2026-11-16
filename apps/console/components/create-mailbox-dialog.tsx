"use client"

import * as React from "react"
import { useOrganization } from "@clerk/nextjs"
import { Plus } from "lucide-react"
import { Alert } from "@repo/ui/components/alert/alert"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { StateButton } from "@repo/ui/components/i10/state-button"
import { ValidatedInput } from "@repo/ui/components/i10/validated-field"
import {
  MorphSelect,
  type MorphSelectOption,
} from "@repo/ui/components/morph-select/morph-select"
import { createMailbox, createOwnMailbox } from "@/lib/actions"
import { formatBytes } from "@/lib/format"
import {
  gigabytesToBytes,
  localPartProblem,
  mailboxRefusal,
  storageField,
  storageProblem,
  type PoolShape,
} from "@/lib/mailbox-create"
import { useOutcome } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"
import { useStepUp } from "@/lib/step-up"
import { toastDone } from "@/lib/toast"

/** A person in the workspace, as the picker needs them. */
export interface WorkspaceMember {
  /** Our user id, the `user_id` the API takes. */
  id: string
  name: string
  email: string
}

/**
 * Creating a mailbox: an owner or admin for a member, or a member for
 * themselves where the workspace lets them.
 *
 * ⚠ EVERY REFUSAL IS SAID IN THE DIALOG, NOT IN A TOAST (the opposite of
 * `FormDialog`, on purpose). Most of what the API can say here names the very
 * thing to change - an address that is taken, a person who already has a
 * mailbox, a plan with no room - and a toast puts that sentence in the corner
 * while the form it is about stays where it is. The dialog stays open with
 * everything typed, and the sentence sits above the button as an alert, so it is
 * both next to the fields and announced to a screen reader.
 *
 * ⚠ THE ADMIN PATH IS BEHIND STEP-UP, THE MEMBER'S IS NOT. That is the API's
 * rule (`POST /console/mailboxes` asks for a fresh session; `POST /mailboxes`
 * never does), so the hook runs only for the admin.
 */
export function CreateMailbox({
  actor,
  domains,
  held,
  pool,
  clerkEnabled,
  previewMembers,
}: {
  actor: "admin" | "self"
  /** Domains this workspace hosts mailboxes on: mailbox hosting on and proven. */
  domains: string[]
  /** Member user id to the address they already hold. Those people are shown, disabled. */
  held: Record<string, string>
  pool: PoolShape
  /** Whether Clerk is mounted. The member list comes from it, as on the Team page. */
  clerkEnabled: boolean
  /** Preview mode's people, since there is no Clerk to ask. */
  previewMembers?: WorkspaceMember[]
}) {
  const [open, setOpen] = React.useState(false)
  const stepUp = useStepUp()
  const outcome = useOutcome()

  const [person, setPerson] = React.useState<string | null>(null)
  const [local, setLocal] = React.useState("")
  const [domain, setDomain] = React.useState(domains[0] ?? "")
  const [name, setName] = React.useState("")
  const [storage, setStorage] = React.useState("")
  const [refusal, setRefusal] = React.useState<string | null>(null)

  useResetOnOpen(open, () => {
    outcome.reset()
    setPerson(null)
    setLocal("")
    setDomain(domains[0] ?? "")
    setName("")
    setStorage("")
    setRefusal(null)
  })

  const activeDomain = domains.includes(domain) ? domain : (domains[0] ?? "")
  const storageKind = storageField(pool, actor)
  const bytes = gigabytesToBytes(storage)

  const localOk = local.trim() !== "" && localPartProblem(local) === null
  const storageOk =
    storageKind === "none" ||
    (storageKind === "optional" && storage.trim() === "") ||
    (storage.trim() !== "" &&
      storageProblem(storage, pool.remaining, formatBytes) === null)
  const ready = localOk && storageOk && (actor === "self" || person !== null)

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
        if (actor === "admin" && !(await stepUp())) return false

        const address = `${local.trim().toLowerCase()}@${activeDomain}`
        const display = name.trim()
        const result =
          actor === "admin"
            ? await createMailbox({
                user_id: person ?? "",
                address,
                ...(display ? { display_name: display } : {}),
                ...(storageKind !== "none" && bytes !== null
                  ? { storage_allocation: bytes }
                  : {}),
              })
            : await createOwnMailbox({
                address,
                ...(display ? { display_name: display } : {}),
              })

        if (!result.ok) {
          setRefusal(mailboxRefusal(result, actor))
          return false
        }
        toastDone("Mailbox created", `${result.data.address} is ready to use.`)
        return true
      },
      () => setOpen(false),
    )
  }

  const trigger = (
    <Button size="sm" onClick={() => setOpen(true)}>
      <Plus />
      Create mailbox
    </Button>
  )

  return (
    <>
      {trigger}
      <Dialog
        open={open}
        onOpenChange={outcome.state === "pending" ? () => {} : setOpen}
      >
        <DialogContent
          title="Create mailbox"
          description={
            domains.length === 0
              ? "A mailbox needs a domain to live on."
              : actor === "admin"
                ? "Give a member an email address they can read and send from in any mail app."
                : "Create your own email address to read and send from in any mail app."
          }
          style={{ width: "min(calc(100vw - 2rem), 448px)" }}
        >
          {domains.length === 0 ? (
            <NoDomain actor={actor} onClose={() => setOpen(false)} />
          ) : (
            <form onSubmit={submit} {...outcome.formProps}>
              <div className="space-y-4 py-4">
                {actor === "admin" && (
                  <MemberSource
                    clerkEnabled={clerkEnabled}
                    previewMembers={previewMembers}
                  >
                    {(members, loading) => (
                      <MemberPicker
                        members={members}
                        loading={loading}
                        held={held}
                        value={person}
                        onChange={edit(setPerson)}
                        disabled={outcome.state !== "idle"}
                      />
                    )}
                  </MemberSource>
                )}

                <ValidatedInput
                  id="mailbox-local-part"
                  label="Address"
                  value={local}
                  onChange={(event) => edit(setLocal)(event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={80}
                  check={localPartProblem}
                  required="Enter the part before the @, like alice."
                  hint={
                    local.trim()
                      ? `The address will be ${local.trim().toLowerCase()}@${activeDomain}`
                      : `The part before the @, like alice. It ends in @${activeDomain}.`
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
                  id="mailbox-display-name"
                  label="Display name (optional)"
                  value={name}
                  onChange={(event) => edit(setName)(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={255}
                  hint={
                    actor === "admin"
                      ? "Shown in mail apps. Leave it empty to use the person's name."
                      : "Shown in mail apps. Leave it empty to use your name."
                  }
                />

                {storageKind !== "none" && (
                  <ValidatedInput
                    id="mailbox-storage"
                    label={
                      storageKind === "required"
                        ? "Storage in GB"
                        : "Storage limit in GB (optional)"
                    }
                    value={storage}
                    onChange={(event) => edit(setStorage)(event.target.value)}
                    inputMode="decimal"
                    autoComplete="off"
                    check={(value) =>
                      storageProblem(value, pool.remaining, formatBytes)
                    }
                    required={
                      storageKind === "required"
                        ? "Enter how much storage this mailbox gets, like 5."
                        : undefined
                    }
                    hint={
                      storageKind === "required"
                        ? pool.remaining === null
                          ? "Taken from your storage pool."
                          : `${formatBytes(pool.remaining)} left in your storage pool.`
                        : "Leave it empty for no limit. You pay for what the mailbox uses."
                    }
                  />
                )}

                {refusal && (
                  <Alert tone="danger" title="Could not create the mailbox">
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
                  pendingLabel="Create mailbox"
                  doneLabel="Created"
                  disabled={!ready}
                >
                  Create mailbox
                </StateButton>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** What the dialog says when there is no domain to put a mailbox on. */
function NoDomain({
  actor,
  onClose,
}: {
  actor: "admin" | "self"
  onClose: () => void
}) {
  return (
    <>
      <p className="py-4 text-sm text-muted-foreground">
        {actor === "admin"
          ? "Set up a domain for mailboxes first: add the domain, then turn on mailbox hosting for it on its page."
          : "No domain in this workspace hosts mailboxes yet. Ask an owner or admin to set one up."}
      </p>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
        {actor === "admin" && (
          <ButtonLink href="/domains" size="md">
            Go to domains
          </ButtonLink>
        )}
      </DialogFooter>
    </>
  )
}

/**
 * Who the picker offers: preview's people, Clerk's member list, or nobody.
 *
 * ⚠ A RENDER PROP, SO THE CLERK HOOK IS CONDITIONAL WITHOUT A CONDITIONAL HOOK.
 * `useOrganization` throws outside `<ClerkProvider>`, which is absent in the
 * no-key review setup (see rename-workspace.tsx). It is also only mounted while
 * the dialog is open, so the list is not fetched for a page nobody creates from.
 */
function MemberSource({
  clerkEnabled,
  previewMembers,
  children,
}: {
  clerkEnabled: boolean
  previewMembers: WorkspaceMember[] | undefined
  children: (members: WorkspaceMember[], loading: boolean) => React.ReactNode
}) {
  if (previewMembers) return children(previewMembers, false)
  if (!clerkEnabled) return children([], false)
  return <ClerkMembers>{children}</ClerkMembers>
}

function ClerkMembers({
  children,
}: {
  children: (members: WorkspaceMember[], loading: boolean) => React.ReactNode
}) {
  const { memberships } = useOrganization({
    memberships: { infinite: true, pageSize: 100, keepPreviousData: true },
  })

  // A workspace is a handful of people; take every page so search sees them all.
  const more = memberships?.hasNextPage && !memberships.isFetching
  const fetchNext = memberships?.fetchNext
  React.useEffect(() => {
    if (more) void fetchNext?.()
  }, [more, fetchNext])

  const members = (memberships?.data ?? []).flatMap((membership) => {
    const data = membership.publicUserData
    if (!data?.userId) return []
    const full = [data.firstName, data.lastName].filter(Boolean).join(" ")
    return [
      {
        id: data.userId,
        name: full || data.identifier || "Member",
        email: data.identifier ?? "",
      },
    ]
  })

  return children(members, Boolean(memberships?.isLoading) || Boolean(more))
}

function MemberPicker({
  members,
  loading,
  held,
  value,
  onChange,
  disabled,
}: {
  members: WorkspaceMember[]
  loading: boolean
  held: Record<string, string>
  value: string | null
  onChange: (id: string | null) => void
  disabled: boolean
}) {
  const items = React.useMemo<MorphSelectOption[]>(
    () =>
      members.map((member) => {
        const address = held[member.id]
        return {
          value: member.id,
          label: member.name,
          keywords: member.email,
          // Somebody with a mailbox is still listed, so it is clear why they
          // cannot be picked, and the address says which one is theirs.
          ...(address ? { meta: address, disabled: true } : {}),
        }
      }),
    [members, held],
  )

  return (
    <MorphSelect
      label="Person"
      items={items}
      value={value}
      onValueChange={(id) => onChange(id)}
      searchable
      searchPlaceholder="Search people"
      placeholder={
        loading
          ? "Loading people"
          : members.length === 0
            ? "No members found"
            : "Choose a person"
      }
      disabled={disabled || (items.length === 0 && !loading)}
    />
  )
}
