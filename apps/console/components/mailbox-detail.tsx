"use client"

import * as React from "react"
import { Inbox, Pause, Play, RotateCw, Trash2, Undo2 } from "lucide-react"
import { Alert } from "@repo/ui/components/alert/alert"
import { Badge } from "@repo/ui/components/badge/badge"
import { Bone, BoneScope } from "@repo/ui/components/bone/bone"
import { Button } from "@repo/ui/components/button/button"
import {
  Page,
  PageBody,
  PageHeader,
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { UsageMeter } from "@repo/ui/components/usage-meter/usage-meter"
import { DetailHero, MetaGrid } from "@/components/detail-hero"
import { RememberShape, useRecordShape } from "@/components/list/remembered-shapes"
import { useMailboxActions } from "@/components/mailbox-actions"
import { MailboxAliases } from "@/components/mailbox-aliases"
import { MailboxTransfer } from "@/components/mailbox-transfer"
import { Time } from "@/components/time"
import {
  availableActions,
  DELETE_GRACE_DAYS,
  exportWaitWords,
  meterScale,
  signInLabel,
  statusInfo,
  statusNote,
  storageLine,
  type ConsoleMailbox,
  type ConsoleMailboxDeletion,
} from "@/lib/mailbox-view"
import { NONE } from "@/lib/react"
import {
  mailboxDetailShape,
  type MailboxDetailData,
  type MailboxDetailShape,
} from "@/lib/shapes/mailbox-detail"

/** What loading.tsx renders: the view with the shape seeded from the list row. */
export function MailboxDetailLoading() {
  return <MailboxDetailView shape={useRecordShape(mailboxDetailShape, "address")} />
}

/**
 * One mailbox: who has it, what state it is in, how full it is, the other
 * addresses that deliver to it, and - for an owner or admin - the five things that
 * can be done to it. ONE view for the page and its skeleton
 * (docs/decisions/skeletons.md).
 *
 * ⚠ STRUCTURE COMES FROM THE SHAPE ALONE (the hero's button, the banner and note,
 * the storage meter, the aliases, the export and import cards, the danger zone);
 * `data` only fills the bones.
 *
 * ⚠ A MEMBER SEES THE SAME PAGE WITHOUT THE BUTTONS. The API already answers a
 * member only for their own address (404 for anyone else's), so what is left to
 * decide here is which controls to show, and it is the list's rule
 * (`members:manage`), not a second one. Every button is still behind the API's
 * own check and a fresh session.
 *
 * ⚠ THE ACTIONS ARE THE LIST ROW MENU'S SAME DIALOGS (`useMailboxActions`), so a
 * mailbox is suspended, resumed, restored and deleted by one flow wherever
 * somebody starts it.
 *
 * ⚠ `renderedAt` COMES FROM THE SERVER, not `new Date()` here: this renders twice
 * (server, then hydration), and whether Restore is offered turns on the clock.
 * One value for both passes cannot disagree.
 */
export function MailboxDetailView({
  shape,
  data,
}: {
  shape: MailboxDetailShape
  data?: MailboxDetailData
}) {
  const loading = data === undefined
  const mailbox = data?.mailbox
  const isAdmin = data?.isAdmin ?? false
  const actions = useMailboxActions({
    mailboxes: data ? [data.mailbox, ...data.others] : NONE,
    pool: data?.pool ?? null,
  })
  const offered =
    data && isAdmin ? availableActions(data.mailbox, new Date(data.renderedAt)) : []
  const status = mailbox ? statusInfo(mailbox.status) : undefined
  const note = mailbox ? statusNote(mailbox.status, mailbox.domain) : null
  const owner = mailbox ? (mailbox.owner.name ?? mailbox.owner.email ?? "Unknown") : ""
  // Pressed before the page has its mailbox, a button has nothing to act on.
  const start = (action: Parameters<typeof actions.start>[0]) => {
    if (mailbox) actions.start(action, mailbox.address)
  }

  return (
    <BoneScope id="mailbox-detail" loading={loading}>
      <Page aria-busy={loading}>
        <PageHeader>
          <DetailHero
            crumbs={[{ label: "Mailboxes", href: "/mailboxes" }]}
            icon={<Inbox />}
            eyebrow={mailbox?.address}
            title={<span className="font-mono">{mailbox?.address}</span>}
            actions={
              shape.action === "suspend" ? (
                <Button variant="secondary" size="sm" onClick={() => start("suspend")}>
                  <Pause aria-hidden="true" />
                  Suspend
                </Button>
              ) : shape.action === "resume" ? (
                <Button size="sm" onClick={() => start("resume")}>
                  <Play aria-hidden="true" />
                  Resume
                </Button>
              ) : undefined
            }
          />
        </PageHeader>

        <PageBody className="space-y-8">
          {shape.deleting && (
            <Bone
              id="deletion"
              as="div"
              shape="box"
              width="100%"
              height={112}
              radius={8}
            >
              {mailbox?.deletion && (
                <DeletionBanner
                  deletion={mailbox.deletion}
                  isAdmin={isAdmin}
                  restorable={offered.includes("restore")}
                  onRestore={() => start("restore")}
                  retryable={offered.includes("retry_export")}
                  onRetry={() => start("retry_export")}
                />
              )}
            </Bone>
          )}

          {shape.note !== "none" && (
            <Bone id="note" as="div" shape="box" width="100%" height={72} radius={8}>
              {status && note && (
                <Alert
                  tone={status.tone === "danger" ? "danger" : "warning"}
                  title={status.label}
                >
                  {note}
                </Alert>
              )}
            </Bone>
          )}

          <MetaGrid
            items={[
              {
                label: "Display name",
                value: mailbox ? (mailbox.displayName ?? "Not set") : undefined,
              },
              { label: "Owner", value: mailbox ? owner : undefined },
              {
                label: "Domain",
                value: mailbox ? (
                  <span className="font-mono">{mailbox.domain}</span>
                ) : undefined,
              },
              {
                label: "Status",
                value: status ? (
                  <Badge tone={status.tone}>{status.label}</Badge>
                ) : undefined,
              },
              {
                label: "Signs in with",
                value: mailbox ? signInLabel(mailbox.signIn) : undefined,
              },
              {
                label: "Created",
                value: mailbox ? <Time iso={mailbox.createdAt} /> : undefined,
              },
            ]}
          />

          <div>
            <Section className="pt-0">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <SectionTitle>Storage</SectionTitle>
                  <SectionDescription>
                    How much of the mailbox is used, out of what it was given.
                  </SectionDescription>
                </div>
                {shape.storageAction && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    onClick={() => start("storage")}
                  >
                    Change storage
                  </Button>
                )}
              </div>
              <SectionContent>
                <StorageCard storage={mailbox?.storage} meter={shape.meter} />
              </SectionContent>
            </Section>

            <MailboxAliases
              shape={shape}
              data={
                data && {
                  mailbox: data.mailbox,
                  list: data.aliases,
                  domains: data.domains,
                  isAdmin,
                }
              }
            />

            <MailboxTransfer
              shape={shape}
              data={
                data && {
                  address: data.mailbox.address,
                  deleting: data.mailbox.status === "deleting",
                  snapshot: data.transfer,
                }
              }
            />

            {shape.danger && (
              <Section>
                <SectionTitle className="text-destructive">Danger zone</SectionTitle>
                <SectionContent>
                  {/* ⚠ THE BORDER IS THE SIGNAL, NOT A RED FILL: see DomainDangerZone. */}
                  <div className="rounded-xl border border-destructive/30">
                    <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="space-y-1">
                        <p className="text-sm font-medium">Delete this mailbox</p>
                        <p className="text-sm text-muted-foreground">
                          Sign-in stops right away. You choose what happens to the mail,
                          and you can restore the mailbox for {DELETE_GRACE_DAYS} days.
                        </p>
                      </div>
                      <Button
                        variant="danger"
                        size="sm"
                        className="shrink-0 self-start sm:self-auto"
                        onClick={() => start("delete")}
                      >
                        <Trash2 aria-hidden="true" />
                        Delete mailbox
                      </Button>
                    </div>
                  </div>
                </SectionContent>
              </Section>
            )}
          </div>
        </PageBody>
        {actions.dialogs}
        {data && <RememberShape def={mailboxDetailShape} shape={shape} />}
      </Page>
    </BoneScope>
  )
}

/** Used against allocated, as a bar where there is a limit to be against. */
function StorageCard({
  storage,
  meter,
}: {
  storage: ConsoleMailbox["storage"] | undefined
  meter: boolean
}) {
  const allocated = storage?.allocatedBytes ?? null
  const used = storage?.usedBytes ?? null
  return (
    <div className="rounded-2xl border bg-card p-6">
      {meter ? (
        <Bone id="meter" as="div" shape="box" width="100%" height={44} radius={8}>
          {allocated !== null && used !== null && (
            <UsageMeter
              label="Mailbox storage"
              limit={allocated / meterScale(allocated).divisor}
              decimals={1}
              unit={meterScale(allocated).unit}
              segments={[
                {
                  id: "used",
                  label: "Used",
                  value: used / meterScale(allocated).divisor,
                },
              ]}
            />
          )}
        </Bone>
      ) : (
        <p className="text-sm">
          <Bone id="storage-line" width={180}>
            {storage && storageLine(storage)}
          </Bone>
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        <Bone id="measured" lineHeight={16} width="60%">
          {storage && (
            <>
              {storage.usedAt ? (
                <>
                  Measured <Time iso={storage.usedAt} />.{" "}
                </>
              ) : null}
              {allocated === null
                ? "No storage was given to this mailbox, so it uses the default quota."
                : null}
            </>
          )}
        </Bone>
      </p>
    </div>
  )
}

/**
 * What a deletion means, in the order a person reads it: that it happened, when
 * the mail stops arriving, what becomes of it, and the way back.
 *
 * ⚠ THE DATE IS WHEN IT CAN NO LONGER BE RESTORED, which is also when the erasing
 * starts, so one date answers both questions. An export can push the erasing past
 * it (the purge waits for the export), which the export sentence says.
 *
 * ⚠ ONLY AN ADMIN GETS THE BUTTON, and only inside the window. After it the
 * banner says the mailbox is being removed rather than offering what the API
 * would refuse (`restore_window_closed`).
 */
function DeletionBanner({
  deletion,
  isAdmin,
  restorable,
  onRestore,
  retryable,
  onRetry,
}: {
  deletion: ConsoleMailboxDeletion
  isAdmin: boolean
  restorable: boolean
  onRestore: () => void
  retryable: boolean
  onRetry: () => void
}) {
  const date = <Time iso={deletion.purgeAt} mode="exact" />
  const wait = exportWaitWords(deletion.exportWait, {
    restorable: restorable && isAdmin,
    isAdmin,
  })
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-danger/25 bg-danger/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <p className="text-sm font-medium">Deleted</p>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {deletion.outcome === "delete" && (
            <>
              Mail keeps arriving until {date}, then the mailbox and its mail are
              erased.
            </>
          )}
          {deletion.outcome === "export_then_delete" && (
            <>
              We are exporting its mail first. Mail keeps arriving until {date}. The
              mailbox is then erased, once the export has finished and its download
              window has passed.
            </>
          )}
          {deletion.outcome === "forward" && (
            <>
              Mail keeps arriving until {date}. After that the mailbox is erased, and
              the address and its aliases keep delivering to{" "}
              <span className="font-mono text-foreground">
                {deletion.forwardTo ?? "another mailbox"}
              </span>
              .
            </>
          )}{" "}
          Nobody can sign in meanwhile.{" "}
          {restorable
            ? isAdmin
              ? "Restore it before then to keep everything."
              : "Ask an owner or admin to restore it before then."
            : `The ${DELETE_GRACE_DAYS} days to restore it are over, and it is being removed.`}
        </p>
        {wait && (
          <p className="max-w-2xl text-sm font-medium">
            {wait.text}
            {wait.date && (
              <>
                {" "}
                <Time iso={wait.date} mode="exact" />.
              </>
            )}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2 self-start sm:self-auto">
        {isAdmin && retryable && (
          <Button size="sm" onClick={onRetry}>
            <RotateCw aria-hidden="true" />
            Start export again
          </Button>
        )}
        {isAdmin && restorable && (
          <Button
            size="sm"
            variant={retryable ? "secondary" : undefined}
            onClick={onRestore}
          >
            <Undo2 aria-hidden="true" />
            Restore
          </Button>
        )}
      </div>
    </div>
  )
}
