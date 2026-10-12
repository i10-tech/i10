"use client"

import * as React from "react"
import { FileDropzone } from "@repo/ui/components/file-dropzone/file-dropzone"
import { Upload } from "lucide-react"
import { Button } from "@repo/ui/components/button/button"
import { Dialog, DialogContent } from "@repo/ui/components/dialog/dialog"
import { DialogFooter } from "@repo/ui/components/i10/dialog-footer"
import { StepStage } from "@repo/ui/components/i10/step-stage"
import { cn } from "cn"
import { importContacts } from "@/lib/actions"
import { formatNumber } from "@/lib/format"
import { useResetOnOpen } from "@/lib/react"
import { toastError } from "@/lib/toast"

const MAX_BYTES = 20 * 1024 * 1024

/**
 * Importing a CSV.
 *
 * ⚠ THE FILE IS READ IN THE BROWSER AND POSTED AS TEXT, NOT AS MULTIPART. The
 * server action takes a string, which means no upload endpoint, no temp file
 * and no multipart parser - and the parser on the API is already a string
 * parser. The cost is that the whole file is in memory twice, which is why the
 * size cap is enforced HERE as well as on the API: refusing a 400 MB file
 * before reading it is the difference between a message and a dead tab.
 *
 * ⚠ AND THE RESULT DISTINGUISHES CREATED FROM UPDATED, WHICH IS THE ONLY WAY TO
 * KNOW WHETHER AN IMPORT DID ANYTHING. "1,000 contacts imported" after
 * accidentally re-uploading last month's file is indistinguishable from a
 * successful first run; "0 created, 1,000 updated" is immediately obvious.
 *
 * ⚠ RE-IMPORTING NEVER RESUBSCRIBES ANYONE. The upsert on the API deliberately
 * leaves `unsubscribed` alone - see `upsertContact` - because somebody's choice
 * to opt out has to outlive our spreadsheets. The dialog says so, because the
 * opposite is what most people assume.
 */
export function ImportContactsButton() {
  const [open, setOpen] = React.useState(false)
  const [file, setFile] = React.useState<File | null>(null)
  // Bumped on each opening, to give the drop zone a fresh start.
  const [round, setRound] = React.useState(0)
  const [pending, setPending] = React.useState(false)
  const [result, setResult] = React.useState<{
    parsed: number
    created: number
    updated: number
    invalid: number
  } | null>(null)

  // ⚠ ON OPEN, NOT ON CLOSE. Cleared on close, the figures vanished and the
  // drop zone snapped back while "Done" was still fading out. See
  // `useResetOnOpen`.
  useResetOnOpen(open, () => {
    setFile(null)
    setResult(null)
    setRound((n) => n + 1)
  })

  async function submit() {
    if (!file || pending) return

    setPending(true)
    /*
     * ⚠ `file.text()` DECODES AS UTF-8, WHICH IS ALMOST ALWAYS RIGHT AND
     * OCCASIONALLY NOT. A CSV exported from a Windows tool may be
     * windows-1252, and a name with an accent then arrives mangled. Detecting
     * the encoding properly needs a library and a heuristic; the address column
     * - the only one that must be exact - is ASCII in every real case, so the
     * damage is limited to a display name. Worth knowing, not worth a
     * dependency yet.
     */
    const text = await file.text()
    const outcome = await importContacts(text)
    setPending(false)

    if (!outcome.ok) {
      toastError("Import failed", { description: outcome.error })
      return
    }

    // No refresh: `importContacts` re-renders this page in its own response,
    // so the table behind already has the new rows. See lib/actions.ts.
    setResult(outcome.data)
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Upload />
        Import
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return
          setOpen(next)
        }}
      >
        <DialogContent
          title="Import contacts"
          description="A CSV with an email column. Anything else becomes a merge field you can use in a broadcast."
          style={{ width: "min(calc(100vw - 2rem), 512px)" }}
        >
          {/*
           * ⚠ THE DROP ZONE SLIDES ON TO THE FIGURES RATHER THAN BEING SWAPPED
           * FOR THEM. They are different heights; a hard swap resized the
           * dialog in one frame, around the numbers somebody was waiting for.
           */}
          <StepStage step={result ? "result" : "pick"}>
            {result ? (
              <div className="space-y-3 py-2">
                <dl className="grid grid-cols-3 divide-x overflow-hidden rounded-lg border">
                  <Figure label="Added" value={result.created} />
                  <Figure label="Updated" value={result.updated} />
                  <Figure
                    label="Skipped"
                    value={result.invalid}
                    tone={result.invalid > 0 ? "warning" : undefined}
                  />
                </dl>

                {result.invalid > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {formatNumber(result.invalid)}{" "}
                    {result.invalid === 1 ? "row was" : "rows were"} skipped because the
                    address was missing or did not look like one.
                  </p>
                )}

                {result.parsed === 0 && (
                  <p className="rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-xs">
                    We could not find an email column. The header needs one of:{" "}
                    <code className="font-mono">email</code>,{" "}
                    <code className="font-mono">email address</code>,{" "}
                    <code className="font-mono">e-mail</code>.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3 py-2">
                {/*
                 * Arc's FileDropzone: drop or choose one CSV, shown as a file
                 * row with its size and a remove. Keyed per opening, so a new
                 * import never starts with the last one's file in it.
                 */}
                <FileDropzone
                  key={round}
                  accept=".csv,text/csv"
                  multiple={false}
                  maxFiles={1}
                  maxSize={MAX_BYTES}
                  label="Contacts CSV"
                  description="Drop a CSV here, or choose one."
                  note="CSV, up to 20 MB"
                  onFilesChange={(files) => {
                    setFile(files[0] ?? null)
                    setResult(null)
                  }}
                />

                <p className="text-xs text-muted-foreground">
                  Re-importing is safe: existing contacts are updated rather than
                  duplicated, and anyone who unsubscribed{" "}
                  <strong className="font-medium text-foreground">stays</strong>{" "}
                  unsubscribed.
                </p>
              </div>
            )}
          </StepStage>

          <DialogFooter>
            {result ? (
              <Button onClick={() => setOpen(false)}>Done</Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                >
                  Cancel
                </Button>
                <Button loading={pending} onClick={submit} disabled={!file || pending}>
                  Import
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: "warning"
}) {
  return (
    <div className="px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "tabular mt-0.5 text-xl font-medium",
          tone === "warning" && value > 0 && "text-warning",
        )}
      >
        {formatNumber(value)}
      </dd>
    </div>
  )
}
