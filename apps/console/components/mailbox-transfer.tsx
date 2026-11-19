"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Download, FileUp, RotateCw, X } from "lucide-react"
import { Alert } from "@repo/ui/components/alert/alert"
import { Bone, useBoneLoading } from "@repo/ui/components/bone/bone"
import { Button } from "@repo/ui/components/button/button"
import { ButtonLink } from "@repo/ui/components/i10/button-link"
import {
  Section,
  SectionContent,
  SectionDescription,
  SectionTitle,
} from "@repo/ui/components/i10/page"
import { Spinner } from "@repo/ui/components/i10/spinner"
import { Progress } from "@repo/ui/components/progress/progress"
import { MailboxImportDialog } from "@/components/mailbox-import-dialog"
import { Time } from "@/components/time"
import {
  exportView,
  flowFailureTitle,
  importView,
  isActive,
  isBusy,
  transferRefusal,
  transferRefusalTitle,
  UNAVAILABLE_WORDS,
  uploadLine,
  uploadPercent,
  EXPORT_KEEP_MS,
  type ExportView,
  type ImportFlow,
  type ImportView,
  type MailboxJob,
  type TransferSnapshot,
} from "@/lib/mailbox-transfer"
import {
  readMailboxExport,
  readMailboxImport,
  startMailboxExport,
} from "@/lib/mailbox-transfer-actions"
import type { MailboxDetailShape } from "@/lib/shapes/mailbox-detail"
import { useStepUp } from "@/lib/step-up"
import { toastDone } from "@/lib/toast"
import { useJobPoll } from "@/lib/use-job-poll"
import { useMailboxImport } from "@/lib/use-mailbox-import"

/** The link the section is reached by from elsewhere on the page, and from the nav later. */
export const TRANSFER_SECTION_ID = "transfer"

const KEEP_DAYS = EXPORT_KEEP_MS / 86_400_000

/**
 * Taking a mailbox's mail out as a file, and bringing mail in from another app.
 *
 * ⚠ THE SECTION IS FOR EVERYONE WHO MAY USE IT, WHICH IS MORE THAN ADMINS: the
 * mailbox's own owner may export and import too. The page reads the two latest
 * jobs on the server (a 403 there hides the section) and the API stays the
 * check on every button.
 *
 * ⚠ THE JOBS ARE HELD HERE, AND EACH NEW STATE COMES FROM AN ACTION'S ANSWER OR
 * FROM A POLL, NEVER FROM A REFRESH OF THE PAGE. A refresh behind an open dialog
 * or a running upload would hand the server's older copy to a screen that is
 * ahead of it. The one refresh asked for is when a deleted mailbox's export ends,
 * so the deletion banner (which reads the same export) does not lag behind.
 *
 * ⚠ A DELETED MAILBOX CAN STILL BE EXPORTED, NOT IMPORTED INTO: the mail is going,
 * so carrying more in would only be erased, and the section says that instead of
 * leaving a disabled button unexplained.
 */
export function MailboxTransfer({
  shape,
  data,
}: {
  shape: MailboxDetailShape
  data?: {
    address: string
    deleting: boolean
    snapshot: TransferSnapshot
  }
}) {
  if (shape.transfer === "hidden") return null
  if (!data) return <TransferFrame {...DRAWN} shape={shape} deleting={shape.deleting} />
  if (data.snapshot.state === "forbidden") return null
  return (
    <TransferSection
      shape={shape}
      address={data.address}
      deleting={data.deleting}
      snapshot={data.snapshot}
    />
  )
}

/** What a skeleton draws the section with: no job, no upload, nothing to press. */
const DRAWN = {
  address: "",
  deleting: false,
  exported: null,
  imported: null,
  exportRefusal: null,
  starting: false,
  flow: { phase: "idle" } as ImportFlow,
  onStart: () => {},
  onChoose: () => {},
  onRetry: () => {},
  onCancel: () => {},
}

function TransferSection({
  shape,
  address,
  deleting,
  snapshot,
}: {
  shape: MailboxDetailShape
  address: string
  deleting: boolean
  snapshot: Exclude<TransferSnapshot, { state: "forbidden" }>
}) {
  const router = useRouter()
  const stepUp = useStepUp()

  const ok = snapshot.state === "ok"
  const [exported, setExported] = React.useState<MailboxJob | null>(
    ok ? snapshot.export : null,
  )
  const [imported, setImported] = React.useState<MailboxJob | null>(
    ok ? snapshot.import : null,
  )
  const [exportRefusal, setExportRefusal] = React.useState<string | null>(null)
  const [starting, setStarting] = React.useState(false)
  const [importing, setImporting] = React.useState(false)

  // ⚠ A NEW SERVER ANSWER (the deletion banner's "Start export again" refreshes
  // the page) REPLACES THE EXPORT, AND THE IMPORT ONLY WHILE NO UPLOAD IS GOING:
  // an upload in progress is ahead of anything the server can say about it.
  const [seen, setSeen] = React.useState(snapshot)
  const imp = useMailboxImport({ address, current: imported, setJob: setImported })
  if (snapshot !== seen) {
    setSeen(snapshot)
    if (snapshot.state === "ok") {
      setExported(snapshot.export)
      if (!isBusy(imp.flow)) setImported(snapshot.import)
    }
  }

  const refreshIfDeleting = (previous: MailboxJob | null, next: MailboxJob) => {
    if (deleting && isActive(previous) && !isActive(next)) router.refresh()
  }
  useJobPoll({
    active: isActive(exported),
    read: () => readMailboxExport(address),
    onJob: (job) => {
      refreshIfDeleting(exported, job)
      setExported(job)
    },
  })
  useJobPoll({
    active: isActive(imported) && !isBusy(imp.flow),
    read: () => readMailboxImport(address),
    onJob: setImported,
  })

  async function startExport() {
    if (starting) return
    setStarting(true)
    setExportRefusal(null)
    try {
      if (!(await stepUp())) return
      const result = await startMailboxExport(address)
      if (!result.ok) {
        setExportRefusal(transferRefusal(result, "export"))
        return
      }
      setExported(result.data)
      toastDone("Export started", `We are exporting the mail in ${address}.`)
    } finally {
      setStarting(false)
    }
  }

  return (
    <TransferFrame
      shape={shape}
      address={address}
      deleting={deleting}
      exported={exported}
      imported={imported}
      exportRefusal={exportRefusal}
      starting={starting}
      flow={imp.flow}
      onStart={startExport}
      onChoose={() => setImporting(true)}
      onRetry={imp.retry}
      onCancel={imp.cancel}
      dialog={
        <MailboxImportDialog
          open={importing}
          onOpenChange={setImporting}
          address={address}
          onBegin={imp.begin}
        />
      }
    />
  )
}

/**
 * The section as the page and its skeleton both draw it: the heading, then the
 * two cards, or the one sentence where this deployment cannot move mail.
 *
 * ⚠ THE SHAPE DECIDES WHICH, so a skeleton and the loaded page agree: whether the
 * jobs could be read, and what each card is in (`exportKind`, `importKind`).
 */
function TransferFrame({
  shape,
  address,
  deleting,
  exported,
  imported,
  exportRefusal,
  starting,
  flow,
  onStart,
  onChoose,
  onRetry,
  onCancel,
  dialog,
}: {
  shape: MailboxDetailShape
  address: string
  deleting: boolean
  exported: MailboxJob | null
  imported: MailboxJob | null
  exportRefusal: string | null
  starting: boolean
  flow: ImportFlow
  onStart: () => void
  onChoose: () => void
  onRetry: () => void
  onCancel: () => void
  dialog?: React.ReactNode
}) {
  if (shape.transfer === "unavailable") {
    return (
      <Section id={TRANSFER_SECTION_ID} className="scroll-mt-6">
        <SectionHeading />
        <SectionContent>
          <div className="rounded-2xl border bg-card px-4 py-6">
            <p className="text-sm text-muted-foreground">{UNAVAILABLE_WORDS}</p>
          </div>
        </SectionContent>
      </Section>
    )
  }

  return (
    <Section id={TRANSFER_SECTION_ID} className="scroll-mt-6">
      <SectionHeading />
      <SectionContent className="space-y-3">
        {shape.transfer === "unreadable" && (
          <Alert tone="warning" title="Could not check for earlier exports or imports">
            Reload the page to see them. You can still start a new one.
          </Alert>
        )}

        <ExportCard
          address={address}
          deleting={deleting}
          kind={shape.exportKind}
          job={exported}
          refusal={exportRefusal}
          starting={starting}
          onStart={onStart}
        />

        <ImportCard
          deleting={deleting}
          kind={shape.importKind}
          job={imported}
          flow={flow}
          onChoose={onChoose}
          onRetry={onRetry}
          onCancel={onCancel}
        />
      </SectionContent>

      {/* The dialog is closed until somebody asks, so a skeleton has none. */}
      {dialog && (
        <span data-skeleton="skip" className="contents">
          {dialog}
        </span>
      )}
    </Section>
  )
}

function SectionHeading() {
  return (
    <div>
      <SectionTitle>Export and import</SectionTitle>
      <SectionDescription>
        Take a copy of this mailbox&apos;s mail, or bring mail over from another mail
        app.
      </SectionDescription>
    </div>
  )
}

/** One of the two cards: what it does, the button that starts it, then its state. */
function TransferCard({
  title,
  description,
  action,
  children,
}: {
  title: string
  description: string
  action?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="max-w-xl text-sm text-muted-foreground">{description}</p>
        </div>
        {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
      </div>
      {children && <div className="mt-4 space-y-3">{children}</div>}
    </div>
  )
}

/**
 * ⚠ A STATUS THAT IS WRITTEN OUT, NOT ONLY DRAWN. The bar says "42%" to the eye
 * and to a screen reader that goes looking, but a change from running to done or
 * failed has to be said by itself: this live region holds one sentence per state
 * (never per tick), so it speaks when the state changes and not before.
 */
function Announce({ text }: { text: string }) {
  return (
    <p className="sr-only" role="status" aria-live="polite">
      {text}
    </p>
  )
}

/** The run's bar where it has a total, and the count with a spinner where it has not. */
function RunProgress({ label, percent }: { label: string; percent: number | null }) {
  if (percent === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" />
        {label}
      </p>
    )
  }
  return <Progress value={percent} label={label} showValue />
}

/**
 * ⚠ THE SAME START AS THE DELETION BANNER'S "Start export again" (the API's
 * `retryExport` and this card's `POST .../export` both end in `startMailboxExport`),
 * so a failed export of a mailbox being deleted offers it under the banner's name.
 *
 * ⚠ LOADING, THE KIND IS THE SHAPE'S; LOADED, IT IS THE JOB'S, which a poll can
 * move from running to ready while the page stays open. What the job says (the
 * buttons it needs, the sentences) is one bone each, so a skeleton and the page
 * differ only inside them.
 */
function ExportCard({
  address,
  deleting,
  kind: shapeKind,
  job,
  refusal,
  starting,
  onStart,
}: {
  address: string
  deleting: boolean
  kind: ExportView["kind"]
  job: MailboxJob | null
  refusal: string | null
  starting: boolean
  onStart: () => void
}) {
  const loading = useBoneLoading()
  const view = exportView(job)
  const kind = loading ? shapeKind : view.kind
  const running = view.kind === "running"

  const again = (label: string, secondary = true) => (
    <Button
      variant={secondary ? "secondary" : "primary"}
      size="sm"
      loading={starting}
      onClick={onStart}
    >
      {kind === "failed" && <RotateCw aria-hidden="true" />}
      {label}
    </Button>
  )

  const action =
    kind === "none" ? (
      again("Export mail")
    ) : kind === "running" ? undefined : (
      <Bone
        id="export-action"
        shape="box"
        width={kind === "ready" ? 216 : 124}
        height={32}
        radius={8}
        inline
      >
        {kind === "ready" ? (
          <>
            <ButtonLink
              native
              size="sm"
              href={`/mailboxes/${encodeURIComponent(address)}/export/download`}
              download
            >
              <Download aria-hidden="true" />
              Download
            </ButtonLink>
            {again("Export again")}
          </>
        ) : kind === "expired" ? (
          again("Export again")
        ) : (
          again(deleting ? "Start export again" : "Try again")
        )}
      </Bone>
    )

  const body = (
    <>
      <Announce
        text={
          running
            ? "Export running."
            : view.kind === "ready"
              ? "The export is ready to download."
              : view.kind === "failed"
                ? "The export failed."
                : ""
        }
      />
      {view.kind === "running" && (
        <RunProgress label={view.line} percent={view.percent} />
      )}
      {view.kind === "ready" && (
        <p className="text-sm">
          Your export is ready.
          {view.expiresAt && (
            <>
              {" "}
              <span className="text-muted-foreground">
                You can download it until <Time iso={view.expiresAt} mode="exact" />.
              </span>
            </>
          )}
        </p>
      )}
      {view.kind === "expired" && (
        <p className="text-sm text-muted-foreground">
          The last export is no longer available. Export again for a new file.
        </p>
      )}
      {view.kind === "failed" && (
        <Alert tone="danger" title="The export did not finish">
          {view.message}
        </Alert>
      )}
      {refusal && (
        <Alert tone="danger" title={transferRefusalTitle("export")}>
          {refusal}
        </Alert>
      )}
    </>
  )

  return (
    <TransferCard
      title="Export mail"
      description={`Download all the mail in this mailbox as one file, to keep as a backup or take elsewhere. We keep the file for ${KEEP_DAYS} days.`}
      action={action}
    >
      {kind === "none" ? (
        body
      ) : (
        <Bone id="export-body" as="div" lines={2}>
          {body}
        </Bone>
      )}
    </TransferCard>
  )
}

function ImportCard({
  deleting,
  kind: shapeKind,
  job,
  flow,
  onChoose,
  onRetry,
  onCancel,
}: {
  deleting: boolean
  kind: ImportView["kind"]
  job: MailboxJob | null
  flow: ImportFlow
  onChoose: () => void
  onRetry: () => void
  onCancel: () => void
}) {
  const loading = useBoneLoading()
  const view = importView(job)
  const kind = loading ? shapeKind : view.kind
  const busy = isBusy(flow)
  const running = view.kind === "running"
  const blocked = deleting || busy || running
  const reason = deleting
    ? "This mailbox is being deleted, so mail can no longer be imported into it."
    : null
  // What the job says, once there is a job to say it: one bone, so a skeleton and
  // the page differ only inside it. Spoken from inside it, so the words are its too.
  const told =
    flow.phase === "idle" &&
    (kind === "running" || kind === "done" || kind === "failed")

  return (
    <TransferCard
      title="Import mail"
      description="Add mail from another mail app, such as a Gmail, Apple Mail, Thunderbird or Outlook export, to this mailbox."
      action={
        flow.phase === "uploading" ? (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            <X aria-hidden="true" />
            Cancel upload
          </Button>
        ) : flow.phase === "failed" ? (
          <>
            <Button size="sm" onClick={onRetry}>
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
            <Button variant="secondary" size="sm" onClick={onCancel}>
              Start over
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={blocked}
            aria-describedby={reason ? "mailbox-import-blocked" : undefined}
            onClick={onChoose}
          >
            <FileUp aria-hidden="true" />
            Import mail
          </Button>
        )
      }
    >
      <Announce text={told ? "" : importAnnouncement(flow, view)} />

      {reason && (
        <p id="mailbox-import-blocked" className="text-sm text-muted-foreground">
          {reason}
        </p>
      )}

      {flow.phase === "reserving" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />
          Preparing the upload
        </p>
      )}
      {flow.phase === "uploading" && (
        <div className="space-y-2">
          <Progress
            value={uploadPercent(flow.sent, flow.total)}
            label={`Uploading ${flow.name}`}
            showValue
          />
          <p className="text-xs text-muted-foreground">
            {uploadLine(flow.sent, flow.total)}. Keep this page open until the upload
            has finished.
          </p>
        </div>
      )}
      {flow.phase === "starting" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />
          Starting the import
        </p>
      )}
      {flow.phase === "failed" && (
        <Alert tone="danger" title={flowFailureTitle(flow.step)}>
          {flow.message}
        </Alert>
      )}

      {flow.phase === "idle" && kind === "unfinished" && (
        <Alert tone="warning" title="An import was started but its file never arrived">
          The upload may have been interrupted. Choose the file again to import it.
        </Alert>
      )}
      {told && (
        <Bone id="import-body" as="div" lines={2}>
          <Announce text={importAnnouncement(flow, view)} />
          {view.kind === "running" && (
            <div className="space-y-2">
              <RunProgress label={view.line} percent={view.percent} />
              <p className="text-xs text-muted-foreground">
                {view.folders ? `${view.folders}. ` : ""}
                You can leave this page: the import carries on, and it shows here when
                you come back.
              </p>
            </div>
          )}
          {view.kind === "done" && (
            <Alert tone="success" title="Import finished">
              {view.headline}
              {view.note ? ` ${view.note}` : ""}
            </Alert>
          )}
          {view.kind === "failed" && (
            <Alert tone="danger" title={view.title}>
              {view.advice}
              {view.detail ? ` Details: ${view.detail}` : ""}
            </Alert>
          )}
        </Bone>
      )}
    </TransferCard>
  )
}

/** One sentence per state, for `Announce`. Empty is silence. */
function importAnnouncement(flow: ImportFlow, view: ReturnType<typeof importView>) {
  if (flow.phase === "uploading") return "Uploading the file."
  if (flow.phase === "starting") return "The file was uploaded. Starting the import."
  if (flow.phase === "failed") return "The import did not start."
  if (flow.phase !== "idle") return ""
  if (view.kind === "running") return "Import running."
  if (view.kind === "done") return "The import finished."
  if (view.kind === "failed") return "The import failed."
  return ""
}
