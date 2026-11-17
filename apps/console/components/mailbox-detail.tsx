"use client"

import * as React from "react"
import { Inbox, Pause, Play, Trash2, Undo2 } from "lucide-react"
import { Alert } from "@repo/ui/components/alert/alert"
import { Badge } from "@repo/ui/components/badge/badge"
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
import { useMailboxActions } from "@/components/mailbox-actions"
import { MailboxAliases } from "@/components/mailbox-aliases"
import { MailboxTransfer } from "@/components/mailbox-transfer"
import { Time } from "@/components/time"
import type { MailboxAliasList } from "@/lib/mailbox-aliases"
import {
  availableActions,
  DELETE_GRACE_DAYS,
  meterScale,
  signInLabel,
  statusInfo,
  statusNote,
  storageLine,
  type ConsoleMailbox,
  type ConsoleMailboxDeletion,
  type StoragePool,
} from "@/lib/mailbox-view"

/**
 * One mailbox: who has it, what state it is in, how full it is, the other
 * addresses that deliver to it, and - for an owner or admin - the five things that
 * can be done to it.
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
export function MailboxDetail({
  mailbox,
  others,
  pool,
  aliases,
  domains,
  isAdmin,
  renderedAt,
}: {
  mailbox: ConsoleMailbox
  /** The workspace's other mailboxes, for a deleted one to forward to. Admins only. */
  others: readonly ConsoleMailbox[]
  /** The storage pool, for the storage dialog. Admins only. */
  pool: StoragePool | null
  /** The addresses that deliver here. Null where they could not be read. */
  aliases: MailboxAliasList | null
  /** The domains the workspace hosts mailboxes on, for the Add alias dialog. Admins only. */
  domains: readonly string[]
  isAdmin: boolean
  renderedAt: string
}) {
  const actions = useMailboxActions({ mailboxes: [mailbox, ...others], pool })
  const offered = isAdmin ? availableActions(mailbox, new Date(renderedAt)) : []
  const status = statusInfo(mailbox.status)
  const note = statusNote(mailbox.status, mailbox.domain)
  const owner = mailbox.owner.name ?? mailbox.owner.email ?? "Unknown"

  return (
    <Page>
      <PageHeader>
        <DetailHero
          crumbs={[{ label: "Mailboxes", href: "/mailboxes" }]}
          icon={<Inbox />}
          eyebrow={mailbox.address}
          title={<span className="font-mono">{mailbox.address}</span>}
          actions={
            offered.includes("suspend") ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => actions.start("suspend", mailbox.address)}
              >
                <Pause aria-hidden="true" />
                Suspend
              </Button>
            ) : offered.includes("resume") ? (
              <Button
                size="sm"
                onClick={() => actions.start("resume", mailbox.address)}
              >
                <Play aria-hidden="true" />
                Resume
              </Button>
            ) : undefined
          }
        />
      </PageHeader>

      <PageBody className="space-y-8">
        {mailbox.deletion && (
          <DeletionBanner
            deletion={mailbox.deletion}
            isAdmin={isAdmin}
            restorable={offered.includes("restore")}
            onRestore={() => actions.start("restore", mailbox.address)}
          />
        )}

        {note && (
          <Alert
            tone={status.tone === "danger" ? "danger" : "warning"}
            title={status.label}
          >
            {note}
          </Alert>
        )}

        <MetaGrid
          items={[
            { label: "Display name", value: mailbox.displayName ?? "Not set" },
            { label: "Owner", value: owner },
            {
              label: "Domain",
              value: <span className="font-mono">{mailbox.domain}</span>,
            },
            {
              label: "Status",
              value: <Badge tone={status.tone}>{status.label}</Badge>,
            },
            { label: "Signs in with", value: signInLabel(mailbox.signIn) },
            { label: "Created", value: <Time iso={mailbox.createdAt} /> },
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
              {offered.includes("storage") && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => actions.start("storage", mailbox.address)}
                >
                  Change storage
                </Button>
              )}
            </div>
            <SectionContent>
              <StorageCard storage={mailbox.storage} />
            </SectionContent>
          </Section>

          <MailboxAliases
            mailbox={mailbox}
            list={aliases}
            domains={domains}
            isAdmin={isAdmin}
          />

          <MailboxTransfer address={mailbox.address} isAdmin={isAdmin} />

          {offered.includes("delete") && (
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
                      onClick={() => actions.start("delete", mailbox.address)}
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
    </Page>
  )
}

/** Used against allocated, as a bar where there is a limit to be against. */
function StorageCard({ storage }: { storage: ConsoleMailbox["storage"] }) {
  const { allocatedBytes, usedBytes, usedAt } = storage
  return (
    <div className="rounded-2xl border bg-card p-6">
      {allocatedBytes !== null && usedBytes !== null ? (
        <UsageMeter
          label="Mailbox storage"
          limit={allocatedBytes / meterScale(allocatedBytes).divisor}
          decimals={1}
          unit={meterScale(allocatedBytes).unit}
          segments={[
            {
              id: "used",
              label: "Used",
              value: usedBytes / meterScale(allocatedBytes).divisor,
            },
          ]}
        />
      ) : (
        <p className="text-sm">{storageLine(storage)}</p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {usedAt ? (
          <>
            Measured <Time iso={usedAt} />.{" "}
          </>
        ) : null}
        {allocatedBytes === null
          ? "No storage was given to this mailbox, so it uses the default quota."
          : null}
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
}: {
  deletion: ConsoleMailboxDeletion
  isAdmin: boolean
  restorable: boolean
  onRestore: () => void
}) {
  const date = <Time iso={deletion.purgeAt} mode="exact" />
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
              the address keeps delivering to{" "}
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
      </div>
      {isAdmin && restorable && (
        <Button
          size="sm"
          className="shrink-0 self-start sm:self-auto"
          onClick={onRestore}
        >
          <Undo2 aria-hidden="true" />
          Restore
        </Button>
      )}
    </div>
  )
}
