"use client"

import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { Eye, History, Loader2, RotateCcw, Rocket, X } from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/components/tooltip"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmailFrame } from "@/components/email-frame"
import { Time } from "@/components/time"
import {
  previewTemplateVersion,
  promoteTemplateVersion,
  restoreTemplateDraft,
} from "@/lib/actions"
import { formatRelative } from "@/lib/format"
import { toastFailure } from "@/lib/toast"
import type { TemplatePreview, TemplateRow, TemplateVersionSummary } from "@/lib/types"

/**
 * Version history: every published version, which one is live, and the two
 * things to do with an old one - send it again, or edit from it.
 *
 * ⚠ "MAKE LIVE" CHANGES WHAT GOES OUT NOW; "RESTORE TO DRAFT" DOES NOT. One
 * moves the pointer sends follow, the other copies the version into the
 * editor and waits for a publish. The confirm says which is which.
 */
export function VersionsPanel({
  templateId,
  history,
  editable,
  imagesFrom,
  onClose,
  onPromoted,
  onRestored,
}: {
  templateId: string
  history: TemplateVersionSummary[]
  editable: boolean
  imagesFrom: string | null
  onClose: () => void
  onPromoted: (row: TemplateRow) => void
  onRestored: (row: TemplateRow) => void
}) {
  const [previewing, setPreviewing] = React.useState<TemplateVersionSummary | null>(
    null,
  )
  const [promoting, setPromoting] = React.useState<TemplateVersionSummary | null>(null)
  const [restoring, setRestoring] = React.useState<TemplateVersionSummary | null>(null)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <p className="text-sm font-medium">Version history</p>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              onClick={onClose}
              aria-label="Close version history"
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {history.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-16 text-center">
            <span className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
              <History className="size-5" />
            </span>
            <p className="mt-4 text-sm font-medium">Nothing published yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Every publish keeps a version here. Sends use the live one, and any
              earlier one can be made live again.
            </p>
          </div>
        ) : (
          <ol className="relative space-y-0.5">
            <AnimatePresence initial={false}>
              {history.map((v) => (
                <motion.li
                  key={v.id}
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="group"
                >
                  <div className="flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/70">
                    <span
                      className={
                        v.live
                          ? "mt-1.5 size-2 shrink-0 rounded-full bg-emerald-500 ring-4 ring-emerald-500/15"
                          : "mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground/40"
                      }
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="tabular font-mono text-xs font-medium">
                          v{v.number}
                        </span>
                        {v.live && <Badge>Live</Badge>}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {v.subject || "No subject"}
                      </p>
                      <p
                        className="text-[11px] text-muted-foreground"
                        title={v.created_at}
                      >
                        {formatRelative(v.created_at)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-7"
                            onClick={() => setPreviewing(v)}
                            aria-label={`Preview v${v.number}`}
                          >
                            <Eye />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Preview</TooltipContent>
                      </Tooltip>
                      {editable && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-7"
                              onClick={() => setRestoring(v)}
                              aria-label={`Restore v${v.number} to the draft`}
                            >
                              <RotateCcw />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Restore to draft</TooltipContent>
                        </Tooltip>
                      )}
                      {!v.live && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="size-7"
                              onClick={() => setPromoting(v)}
                              aria-label={`Make v${v.number} live`}
                            >
                              <Rocket />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Make live</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
      </div>

      <VersionPreviewDialog
        templateId={templateId}
        version={previewing}
        imagesFrom={imagesFrom}
        onOpenChange={(open) => !open && setPreviewing(null)}
      />

      <ConfirmDialog
        open={promoting !== null}
        onOpenChange={(open) => !open && setPromoting(null)}
        title={promoting ? `Make v${promoting.number} live?` : "Make live?"}
        description="Sends that name this template without a version start using it at once. The draft is not touched."
        confirmLabel="Make live"
        doneLabel="Live"
        destructive={false}
        onConfirm={async () => {
          if (!promoting) return false
          const result = await promoteTemplateVersion(templateId, promoting.number)
          if (!result.ok) {
            toastFailure(result)
            return false
          }
          onPromoted(result.data)
          return true
        }}
      />

      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={restoring ? `Edit from v${restoring.number}?` : "Restore?"}
        description="The draft is replaced by this version. Nothing that is sent changes until you publish."
        confirmLabel="Restore to draft"
        doneLabel="Restored"
        destructive={false}
        onConfirm={async () => {
          if (!restoring) return false
          const result = await restoreTemplateDraft(templateId, restoring.number)
          if (!result.ok) {
            toastFailure(result)
            return false
          }
          onRestored(result.data)
          return true
        }}
      />
    </div>
  )
}

function VersionPreviewDialog({
  templateId,
  version,
  imagesFrom,
  onOpenChange,
}: {
  templateId: string
  version: TemplateVersionSummary | null
  imagesFrom: string | null
  onOpenChange: (open: boolean) => void
}) {
  const [loaded, setLoaded] = React.useState<{
    number: number
    preview: TemplatePreview
  } | null>(null)
  const [last, setLast] = React.useState(version)
  if (version && version !== last) setLast(version)
  const shown = version ?? last
  // Only the preview of the version on screen; another's never flashes up.
  const preview = loaded && loaded.number === shown?.number ? loaded.preview : null

  React.useEffect(() => {
    if (!version) return
    let current = true
    void previewTemplateVersion(templateId, version.number).then((r) => {
      if (!current) return
      if (r.ok) setLoaded({ number: version.number, preview: r.data })
      else toastFailure(r)
    })
    return () => {
      current = false
    }
  }, [templateId, version])

  return (
    <Dialog open={version !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            v{shown?.number}
            {shown?.live && <Badge className="ml-2 align-middle">Live</Badge>}
          </DialogTitle>
          <DialogDescription>
            {preview?.subject || shown?.subject || "No subject"}
            {shown && (
              <>
                {" · published "}
                <Time iso={shown.created_at} mode="exact" />
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="h-[60vh] overflow-hidden rounded-lg border bg-white">
          {preview?.html ? (
            <EmailFrame
              html={preview.html}
              title={`v${shown?.number}`}
              imagesFrom={imagesFrom}
              className="h-full"
            />
          ) : (
            <div className="grid h-full place-items-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
