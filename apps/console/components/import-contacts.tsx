"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { FileUp, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@repo/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog"
import { Spinner } from "@repo/ui/components/spinner"
import { cn } from "cn"
import { importContacts } from "@/lib/actions"
import { formatNumber } from "@/lib/format"

const MAX_BYTES = 20 * 1024 * 1024

/**
 * Importing a CSV.
 *
 * ⚠ THE FILE IS READ IN THE BROWSER AND POSTED AS TEXT, NOT AS MULTIPART. The
 * server action takes a string, which means no upload endpoint, no temp file
 * and no multipart parser — and the parser on the API is already a string
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
 * leaves `unsubscribed` alone — see `upsertContact` — because somebody's choice
 * to opt out has to outlive our spreadsheets. The dialog says so, because the
 * opposite is what most people assume.
 */
export function ImportContactsButton() {
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [file, setFile] = React.useState<File | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [result, setResult] = React.useState<{
    parsed: number
    created: number
    updated: number
    invalid: number
  } | null>(null)

  const inputRef = React.useRef<HTMLInputElement>(null)

  function reset() {
    setFile(null)
    setResult(null)
    setDragging(false)
  }

  function accept(next: File | null | undefined) {
    if (!next) return
    if (next.size > MAX_BYTES) {
      toast.error("That file is too large", {
        description: "The limit is 20 MB. Split it and import in parts.",
      })
      return
    }
    setFile(next)
    setResult(null)
  }

  async function submit() {
    if (!file || pending) return

    setPending(true)
    /*
     * ⚠ `file.text()` DECODES AS UTF-8, WHICH IS ALMOST ALWAYS RIGHT AND
     * OCCASIONALLY NOT. A CSV exported from a Windows tool may be
     * windows-1252, and a name with an accent then arrives mangled. Detecting
     * the encoding properly needs a library and a heuristic; the address column
     * — the only one that must be exact — is ASCII in every real case, so the
     * damage is limited to a display name. Worth knowing, not worth a
     * dependency yet.
     */
    const text = await file.text()
    const outcome = await importContacts(text)
    setPending(false)

    if (!outcome.ok) {
      toast.error("Import failed", { description: outcome.error })
      return
    }

    setResult(outcome.data)
    router.refresh()
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          reset()
          setOpen(true)
        }}
      >
        <Upload />
        Import
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) reset()
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import contacts</DialogTitle>
            <DialogDescription>
              A CSV with an email column. Anything else becomes a merge field you can
              use in a broadcast.
            </DialogDescription>
          </DialogHeader>

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
               * ⚠ A LABEL WRAPPING A HIDDEN INPUT, NOT A DIV WITH AN onClick.
               * The label gives keyboard activation and a real focus ring for
               * free; a clickable div gives neither, and file pickers are
               * exactly the control somebody reaches for with the keyboard.
               */}
              <label
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragging(false)
                  accept(event.dataTransfer.files?.[0])
                }}
                className={cn(
                  "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
                  "duration-(--duration-instant) ease-(--ease-linear)",
                  dragging ? "border-foreground/40 bg-muted/40" : "hover:bg-muted/20",
                )}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  onChange={(event) => accept(event.target.files?.[0])}
                />
                <FileUp className="size-5 text-muted-foreground" />
                {file ? (
                  <>
                    <span className="text-sm font-medium">{file.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {(file.size / 1024).toFixed(0)} KB — choose another to replace
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium">
                      Drop a CSV here, or click to choose
                    </span>
                    <span className="text-xs text-muted-foreground">Up to 20 MB</span>
                  </>
                )}
              </label>

              <p className="text-xs text-muted-foreground">
                Re-importing is safe: existing contacts are updated rather than
                duplicated, and anyone who unsubscribed{" "}
                <strong className="font-medium text-foreground">stays</strong>{" "}
                unsubscribed.
              </p>
            </div>
          )}

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
                <Button onClick={submit} disabled={!file || pending}>
                  {pending && <Spinner />}
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
          "tabular mt-0.5 text-xl font-semibold",
          tone === "warning" && value > 0 && "text-warning",
        )}
      >
        {formatNumber(value)}
      </dd>
    </div>
  )
}
