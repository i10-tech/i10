"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Trash2, Users } from "lucide-react"
import { Alert } from "@repo/ui/components/alert/alert"
import { Button } from "@repo/ui/components/button/button"
import { StateButton } from "@repo/ui/components/i10/state-button"
import {
  Page,
  PageBody,
  PageHeader,
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { DeleteTeamInboxDialog } from "@/components/delete-team-inbox-dialog"
import { DetailHero, MetaGrid } from "@/components/detail-hero"
import { TeamInboxMembersField } from "@/components/team-inbox-members-field"
import { Time } from "@/components/time"
import { setTeamInboxMembers } from "@/lib/actions"
import { useOutcome } from "@/lib/outcome"
import { useResetWhen } from "@/lib/react"
import { useStepUp } from "@/lib/step-up"
import {
  HOW_MEMBERS_USE_IT,
  inboxName,
  memberCount,
  membersProblem,
  refusalTitle,
  removedMembers,
  sameMembers,
  teamInboxRefusal,
  type Candidate,
  type TeamInbox,
} from "@/lib/team-inbox"
import { toastDone } from "@/lib/toast"

/**
 * One team inbox: its address, who is in it, and for an owner or admin the two
 * things that can be done to it.
 *
 * ⚠ A MEMBER SEES THE SAME PAGE WITHOUT THE CONTROLS. The API already answers a
 * member only for an inbox they are in (a 404 for any other, which reveals
 * nothing), so what is left to decide here is which controls to show, and it is
 * the list's rule (`members:manage`). Every control is still behind the API's own
 * check and a fresh session.
 */
export function TeamInboxDetail({
  inbox,
  candidates,
  isAdmin,
}: {
  inbox: TeamInbox
  /** People who can be added. Admins only. */
  candidates: readonly Candidate[]
  isAdmin: boolean
}) {
  const router = useRouter()
  const [deleting, setDeleting] = React.useState(false)
  const name = inboxName(inbox)

  return (
    <Page>
      <PageHeader>
        <DetailHero
          crumbs={[{ label: "Team inboxes", href: "/team-inboxes" }]}
          icon={<Users />}
          eyebrow={inbox.address}
          title={<span className="font-mono">{inbox.address}</span>}
        />
      </PageHeader>

      <PageBody className="space-y-8">
        <MetaGrid
          items={[
            { label: "Display name", value: name === inbox.address ? "Not set" : name },
            { label: "Created", value: <Time iso={inbox.created_at} /> },
          ]}
        />

        <div>
          <Section className="pt-0">
            <div>
              <SectionTitle>Members</SectionTitle>
              <SectionDescription>{HOW_MEMBERS_USE_IT}</SectionDescription>
            </div>
            <SectionContent>
              {isAdmin ? (
                <MembersEditor inbox={inbox} candidates={candidates} />
              ) : (
                <MembersList members={inbox.members.map((m) => m.address)} />
              )}
            </SectionContent>
          </Section>

          {isAdmin && (
            <Section>
              <SectionTitle className="text-destructive">Danger zone</SectionTitle>
              <SectionContent>
                {/* ⚠ THE BORDER IS THE SIGNAL, NOT A RED FILL: see DomainDangerZone. */}
                <div className="rounded-xl border border-destructive/30">
                  <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Delete this team inbox</p>
                      <p className="text-sm text-muted-foreground">
                        The shared mailbox and all the mail in it are destroyed for
                        good. The mailboxes of its members are not touched.
                      </p>
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      className="shrink-0 self-start sm:self-auto"
                      onClick={() => setDeleting(true)}
                    >
                      <Trash2 aria-hidden="true" />
                      Delete team inbox
                    </Button>
                  </div>
                </div>
              </SectionContent>
            </Section>
          )}
        </div>
      </PageBody>

      {isAdmin && (
        <DeleteTeamInboxDialog
          address={inbox.address}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={() => router.push("/team-inboxes")}
        />
      )}
    </Page>
  )
}

/** The members a member sees: who else reads the address, with nothing to change. */
function MembersList({ members }: { members: readonly string[] }) {
  return (
    <ul aria-label="Members" className="divide-y rounded-xl border bg-card">
      {members.map((address) => (
        <li key={address} className="truncate px-4 py-2.5 text-sm">
          {address}
        </li>
      ))}
    </ul>
  )
}

/**
 * The member list an owner or admin edits: one local list, one Save that sends
 * the whole thing.
 *
 * ⚠ ONE SAVE FOR THE WHOLE LIST, NOT A WRITE PER CLICK. The API replaces the set
 * (`PUT .../members`), is idempotent, and asks for a fresh session, so adding
 * three people and removing one is a single prompt and a single request. Nothing
 * is saved until Save, and Discard puts the list back.
 *
 * ⚠ THE LIST FOLLOWS THE SERVER'S AFTER A SAVE (and when it changes under us),
 * by resetting during render on the members' joined addresses, the way
 * `useResetWhen` is meant to be used. A save that is refused keeps what was
 * typed.
 */
function MembersEditor({
  inbox,
  candidates,
}: {
  inbox: TeamInbox
  candidates: readonly Candidate[]
}) {
  const stepUp = useStepUp()
  const outcome = useOutcome()
  const saved = React.useMemo(
    () => inbox.members.map((m) => m.address),
    [inbox.members],
  )
  const [members, setMembers] = React.useState<string[]>(saved)
  const [refusal, setRefusal] = React.useState<string | null>(null)

  useResetWhen(saved.join("\n"), () => {
    setMembers(saved)
    setRefusal(null)
  })

  const dirty = !sameMembers(members, saved)
  const problem = membersProblem(members)
  const removed = removedMembers(saved, members)
  const ready = dirty && problem === null

  function edit(next: string[]) {
    setMembers(next)
    setRefusal(null)
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (outcome.state !== "idle" || !ready) return
    setRefusal(null)

    await outcome.run(async () => {
      if (!(await stepUp())) return false
      const result = await setTeamInboxMembers(inbox.address, members)
      if (!result.ok) {
        setRefusal(teamInboxRefusal(result, "members"))
        return false
      }
      toastDone(
        "Members saved",
        `${inbox.address} now has ${memberCount(result.data.members.length)}.`,
      )
      return true
    })
  }

  return (
    <form onSubmit={save} className="space-y-4" {...outcome.formProps}>
      <TeamInboxMembersField
        candidates={candidates}
        value={members}
        onChange={edit}
        disabled={outcome.state !== "idle"}
        hint="People you remove lose access to this inbox right away."
      />

      {dirty && problem && <p className="text-sm text-muted-foreground">{problem}</p>}

      {removed.length > 0 && problem === null && (
        <p className="text-sm text-muted-foreground">
          {removed.length === 1
            ? `${removed[0]} will lose access when you save.`
            : `${removed.length} people will lose access when you save.`}
        </p>
      )}

      {refusal && (
        <Alert tone="danger" title={refusalTitle("members")}>
          {refusal}
        </Alert>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!dirty || outcome.state === "pending"}
          onClick={() => edit(saved)}
        >
          Discard changes
        </Button>
        <StateButton
          type="submit"
          size="sm"
          state={outcome.state}
          pendingLabel="Save members"
          doneLabel="Saved"
          disabled={!ready}
        >
          Save members
        </StateButton>
      </div>
    </form>
  )
}
