"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Trash2, Users } from "lucide-react"
import { Alert } from "@repo/ui/components/alert/alert"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
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
import { RememberShape, useRecordShape } from "@/components/list/remembered-shapes"
import { TeamInboxMembersField } from "@/components/team-inbox-members-field"
import { Time } from "@/components/time"
import { setTeamInboxMembers } from "@/lib/actions"
import { useOutcome } from "@/lib/outcome"
import { useResetWhen } from "@/lib/react"
import {
  teamInboxDetailShape,
  type TeamInboxDetailData,
  type TeamInboxDetailShape,
} from "@/lib/shapes/team-inbox-detail"
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

/** What loading.tsx renders: the view with the shape seeded from the list row. */
export function TeamInboxDetailLoading() {
  return <TeamInboxDetailView shape={useRecordShape(teamInboxDetailShape, "address")} />
}

/** The editor's box while it loads: the search, a row per member, the buttons. */
const EDITOR_BASE_HEIGHT = 112
const EDITOR_ROW_HEIGHT = 44

/**
 * One team inbox: its address, who is in it, and for an owner or admin the two
 * things that can be done to it. ONE view for the page and its skeleton
 * (docs/decisions/skeletons.md).
 *
 * ⚠ A MEMBER SEES THE SAME PAGE WITHOUT THE CONTROLS. The API already answers a
 * member only for an inbox they are in (a 404 for any other, which reveals
 * nothing), so what is left to decide here is which controls to show, and it is
 * the list's rule (`members:manage`). Every control is still behind the API's own
 * check and a fresh session.
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (the editor or the read-only list, the
 * danger zone); `data` only fills the bones. The editor is a form with state of its
 * own, so a skeleton draws its box and not its fields.
 */
export function TeamInboxDetailView({
  shape,
  data,
}: {
  shape: TeamInboxDetailShape
  data?: TeamInboxDetailData
}) {
  const router = useRouter()
  const [deleting, setDeleting] = React.useState(false)
  const loading = data === undefined
  const inbox = data?.inbox
  const name = inbox ? inboxName(inbox) : ""

  return (
    <BoneScope id="team-inbox-detail" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <DetailHero
            crumbs={[{ label: "Team inboxes", href: "/team-inboxes" }]}
            icon={<Users />}
            eyebrow={inbox?.address}
            title={<span className="font-mono">{inbox?.address}</span>}
          />
        </PageHeader>

        <PageBody className="space-y-8">
          <MetaGrid
            items={[
              {
                label: "Display name",
                value: inbox ? (name === inbox.address ? "Not set" : name) : undefined,
              },
              {
                label: "Created",
                value: inbox ? <Time iso={inbox.created_at} /> : undefined,
              },
            ]}
          />

          <div>
            <Section className="pt-0">
              <div>
                <SectionTitle>Members</SectionTitle>
                <SectionDescription>{HOW_MEMBERS_USE_IT}</SectionDescription>
              </div>
              <SectionContent>
                {shape.admin ? (
                  <Bone
                    id="members-editor"
                    as="div"
                    shape="box"
                    width="100%"
                    height={EDITOR_BASE_HEIGHT + shape.members * EDITOR_ROW_HEIGHT}
                    radius={12}
                  >
                    {data && (
                      <MembersEditor inbox={data.inbox} candidates={data.candidates} />
                    )}
                  </Bone>
                ) : (
                  <MembersList
                    members={inbox?.members.map((m) => m.address)}
                    rows={shape.members}
                  />
                )}
              </SectionContent>
            </Section>

            {shape.admin && (
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
                        onClick={() => inbox && setDeleting(true)}
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

        {/* The dialog is closed until somebody asks, so a skeleton has none. */}
        {data && shape.admin && (
          <span data-skeleton="skip" className="contents">
            <DeleteTeamInboxDialog
              address={data.inbox.address}
              open={deleting}
              onOpenChange={setDeleting}
              onDeleted={() => router.push("/team-inboxes")}
            />
          </span>
        )}
        {data && <RememberShape def={teamInboxDetailShape} shape={shape} />}
      </Page>
    </BoneScope>
  )
}

/** The members a member sees: who else reads the address, with nothing to change. */
function MembersList({
  members,
  rows,
}: {
  /** Undefined while loading. */
  members: readonly string[] | undefined
  /** Placeholder rows to draw while loading. */
  rows: number
}) {
  const shown: readonly (string | undefined)[] =
    members ?? Array.from({ length: rows }, () => undefined)
  return (
    <ul aria-label="Members" className="divide-y rounded-xl border bg-card">
      {shown.map((address, i) => (
        <BoneScope key={address ?? i} id={`member-${i}`} unit>
          <li className="truncate px-4 py-2.5 text-sm">
            <Bone id="address" width="56%">
              {address}
            </Bone>
          </li>
        </BoneScope>
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
