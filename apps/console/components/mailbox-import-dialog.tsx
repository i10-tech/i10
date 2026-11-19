"use client"

import * as React from "react"
import { FileUp } from "lucide-react"
import { Alert } from "@repo/ui/components/alert/alert"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { StateButton } from "@repo/ui/components/i10/state-button"
import { formatBytes } from "@/lib/format"
import {
  archiveProblem,
  IMPORT_FORMATS,
  IMPORT_SOURCES,
  MAX_ARCHIVE_BYTES,
  transferRefusalTitle,
} from "@/lib/mailbox-transfer"
import { useOutcome } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"
import type { BeginResult } from "@/lib/use-mailbox-import"

/** The first block a file's kind is read from. */
const HEAD_BYTES = 512

interface Chosen {
  file: File
  /** Why it cannot be imported, or null. Null until the first bytes have been read. */
  problem: string | null
  checked: boolean
}

/**
 * Importing mail into a mailbox: pick the file, see at once whether it can work,
 * and hand it over.
 *
 * ⚠ THE DIALOG ONLY RESERVES. `onBegin` asks for the place in storage (behind
 * step-up) and answers when that is settled; the upload and the start carry on
 * outside this dialog, on the page's own card, so closing it cannot lose them.
 * A refusal of the reservation stays here as an alert with the file still chosen.
 *
 * ⚠ THE FILE IS CHECKED BEFORE ANY STEP-UP OR UPLOAD, from its first 512 bytes
 * (the test the API's reader makes), so a file that would only have failed after
 * hours of sending is refused in a second.
 */
export function MailboxImportDialog({
  open,
  onOpenChange,
  address,
  onBegin,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  address: string
  onBegin: (file: File) => Promise<BeginResult>
}) {
  const outcome = useOutcome()
  const input = React.useRef<HTMLInputElement>(null)
  const [chosen, setChosen] = React.useState<Chosen | null>(null)
  const [refusal, setRefusal] = React.useState<string | null>(null)

  useResetOnOpen(open, () => {
    outcome.reset()
    setChosen(null)
    setRefusal(null)
  })

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // The same input is reused, so the same file can be chosen again after a fix.
    event.target.value = ""
    setRefusal(null)
    if (!file) return

    setChosen({ file, problem: null, checked: false })
    let head = new Uint8Array(0)
    try {
      head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer())
    } catch {
      // A file that cannot be read (moved, or on a drive that went away) is
      // checked by its size and name alone; the upload will say if it is gone.
    }
    const problem = archiveProblem(file, head)
    // ⚠ ONLY IF IT IS STILL THE FILE: a second choice made while this one was
    // being read must not have its answer overwritten by the first's.
    setChosen((now) => (now?.file === file ? { file, problem, checked: true } : now))
  }

  const ready = chosen !== null && chosen.checked && chosen.problem === null

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (outcome.state !== "idle" || !ready) return
    setRefusal(null)
    const file = chosen.file

    await outcome.run(
      async () => {
        const result = await onBegin(file)
        if (result.kind === "refused") {
          setRefusal(result.message)
          return false
        }
        return result.kind === "reserved"
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
        title="Import mail"
        description={`Add mail from another mail app to ${address}.`}
        style={{
          width: "min(calc(100vw - 2rem), 520px)",
          maxHeight: "calc(100dvh - 2rem)",
          overflowY: "auto",
        }}
      >
        <form onSubmit={submit} {...outcome.formProps}>
          <div className="space-y-4 py-4">
            <div className="space-y-2 text-sm">
              <p>
                Choose a {IMPORT_FORMATS} file. Mail that is already in the mailbox
                stays where it is. Importing the same file twice can add its messages
                twice.
              </p>
              <ul className="space-y-1.5 text-muted-foreground">
                {IMPORT_SOURCES.map((source) => (
                  <li key={source.app}>
                    <span className="font-medium text-foreground">{source.app}.</span>{" "}
                    {source.how}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground">
                A file can be up to {formatBytes(MAX_ARCHIVE_BYTES)}. For more, split it
                into parts and import them one at a time. The file goes straight to our
                storage and not through this page&apos;s server, so a large one can take
                a while: keep this page open until it has been sent.
              </p>
            </div>

            <div className="space-y-2">
              <input
                ref={input}
                id="mailbox-import-file"
                type="file"
                // ⚠ NO `accept`: Thunderbird's folder files have no extension and are
                // valid, and a filter would grey them out. The content decides
                // (`archiveProblem`).
                className="sr-only"
                onChange={choose}
                disabled={outcome.state !== "idle"}
                aria-describedby={chosen ? "mailbox-import-chosen" : undefined}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => input.current?.click()}
                  disabled={outcome.state !== "idle"}
                >
                  <FileUp aria-hidden="true" />
                  {chosen ? "Choose a different file" : "Choose file"}
                </Button>
                {chosen && (
                  <p
                    id="mailbox-import-chosen"
                    className="min-w-0 text-sm text-muted-foreground"
                  >
                    <span className="break-all font-medium text-foreground">
                      {chosen.file.name}
                    </span>{" "}
                    ({formatBytes(chosen.file.size)})
                  </p>
                )}
              </div>
            </div>

            {chosen?.problem && (
              <Alert tone="danger" title="That file cannot be imported">
                {chosen.problem}
              </Alert>
            )}
            {refusal && (
              <Alert tone="danger" title={transferRefusalTitle("reserve")}>
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
              pendingLabel="Preparing the upload"
              doneLabel="Uploading"
              disabled={!ready}
            >
              Upload and import
            </StateButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
