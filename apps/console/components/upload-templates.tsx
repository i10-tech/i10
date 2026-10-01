"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { FileCode2, FolderUp, Upload } from "lucide-react"
import { cn } from "cn"
import { ActionButton } from "@repo/ui/components/action-button"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/ui/components/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { uploadTemplates, uploadTemplateVersion } from "@/lib/actions"
import { useOutcome } from "@/lib/outcome"
import { useResetOnOpen } from "@/lib/react"
import type { TemplateUploadOutcome } from "@/lib/types"

/**
 * Uploading React Email templates (#234, #236): a folder, some `.tsx` files, or
 * either dropped on the dialog.
 *
 * ⚠ ONLY CODE LEAVES THE BROWSER. A dropped folder carries images, a README,
 * perhaps a `node_modules`; the API would ignore them, but sending them first
 * would spend the upload limit on bytes nobody reads. What is kept is exactly
 * what the API keeps: `.tsx`, `.ts`, `.jsx`, `.js` and `i10.json`.
 *
 * ⚠ A PICKED FOLDER'S OWN NAME IS NOT PART OF THE PATHS. Choosing `emails/`
 * gives `emails/auth/welcome.tsx`; the template's folder is `auth`, as it is in
 * `email dev`, and as it will be for the same directory connected from GitHub.
 */

const MAX_FILES = 500
const MAX_BYTES = 4 * 1024 * 1024

interface Picked {
  path: string
  file: File
}

type Mode = { kind: "folder" } | { kind: "version"; templateId: string; name: string }

export function UploadTemplatesButton() {
  return (
    <UploadDialog
      mode={{ kind: "folder" }}
      trigger={
        <Button size="sm" variant="outline">
          <Upload />
          Upload
        </Button>
      }
    />
  )
}

/**
 * The same dialog with no button of its own, opened from the templates
 * page's New menu (Template, Folder, Upload files).
 */
export function UploadTemplatesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <UploadDialog mode={{ kind: "folder" }} open={open} onOpenChange={onOpenChange} />
  )
}

export function UploadVersionButton({
  templateId,
  name,
}: {
  templateId: string
  name: string
}) {
  return (
    <UploadDialog
      mode={{ kind: "version", templateId, name }}
      trigger={
        <Button size="sm" variant="outline">
          <Upload />
          Upload new version
        </Button>
      }
    />
  )
}

function UploadDialog({
  mode,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  mode: Mode
  trigger?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const router = useRouter()
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen
  const [picked, setPicked] = React.useState<Picked[]>([])
  const [entry, setEntry] = React.useState("")
  const [problems, setProblems] = React.useState<string[]>([])
  const [results, setResults] = React.useState<TemplateUploadOutcome[] | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const [found, setFound] = React.useState<number | null>(null)
  const uploading = useOutcome()

  useResetOnOpen(open, () => {
    setPicked([])
    setFound(null)
    setEntry("")
    setProblems([])
    setResults(null)
    uploading.reset()
  })

  const bytes = picked.reduce((n, p) => n + p.file.size, 0)
  const entries = picked.filter((p) => /\.(tsx|jsx)$/.test(p.path)).map((p) => p.path)
  const tooMany = picked.length > MAX_FILES
  const tooBig = bytes > MAX_BYTES

  function choose(files: Picked[]) {
    const kept = keepCode(stripCommonRoot(files))
    setPicked(kept)
    setFound(null)
    void countTemplates(kept).then(setFound)
    setProblems([])
    setResults(null)
    if (mode.kind === "version") {
      const tsx = kept.filter((p) => /\.(tsx|jsx)$/.test(p.path))
      const named = tsx.find((p) => stem(p.path) === mode.name)
      setEntry((named ?? tsx[0])?.path ?? "")
    }
  }

  async function submit() {
    if (uploading.state === "pending") return
    await uploading.run(async () => {
      const form = new FormData()
      for (const { path, file } of picked) form.append(path, file)

      if (mode.kind === "version") {
        form.append("$entry", entry)
        const result = await uploadTemplateVersion(mode.templateId, form)
        if (!result.ok) {
          setProblems(problemsOf(result.body) ?? [result.error])
          return false
        }
        setTimeout(() => setOpen(false), 700)
        return true
      }

      const result = await uploadTemplates(form)
      if (!result.ok) {
        setProblems(problemsOf(result.body) ?? [result.error])
        return false
      }
      setResults(result.data.data)
      setProblems(result.data.problems)
      router.refresh()
      return true
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode.kind === "version"
              ? `Upload a new version of ${mode.name}`
              : "Upload templates"}
          </DialogTitle>
          <DialogDescription>
            {mode.kind === "version"
              ? "The template file and anything it imports. It goes live as soon as it is accepted, and the version before it stays one click away."
              : "React Email .tsx files, or a folder of them. Each template goes live as soon as it is accepted; shared components are picked up from the imports."}
          </DialogDescription>
        </DialogHeader>

        {results ? (
          <Results results={results} problems={problems} />
        ) : (
          <div className="space-y-4">
            <div
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={async (event) => {
                event.preventDefault()
                setDragging(false)
                choose(await dropped(event.dataTransfer))
              }}
              className={cn(
                "flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center transition-colors duration-(--duration-instant) ease-(--ease-linear)",
                dragging && "border-foreground/40 bg-muted/40",
              )}
            >
              <p className="text-sm text-muted-foreground">
                Drop files or a folder here, or
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <PickButton multiple onPick={choose}>
                  <FileCode2 />
                  Choose files
                </PickButton>
                <PickButton directory onPick={choose}>
                  <FolderUp />
                  Choose a folder
                </PickButton>
              </div>
            </div>

            {picked.length > 0 && (
              <p className="text-xs text-muted-foreground">
                <span className="tabular">{picked.length}</span>{" "}
                {picked.length === 1 ? "file" : "files"},{" "}
                <span className="tabular">{formatBytes(bytes)}</span>
                {found !== null && mode.kind === "folder" && (
                  <>
                    {" "}
                    -{" "}
                    {found === 0
                      ? "no templates"
                      : found === 1
                        ? "1 template"
                        : `${found} templates`}
                  </>
                )}
              </p>
            )}

            {mode.kind === "version" && entries.length > 1 && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">The template file</p>
                <Select value={entry} onValueChange={setEntry}>
                  <SelectTrigger className="w-full font-mono text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {entries.map((path) => (
                      <SelectItem key={path} value={path} className="font-mono text-xs">
                        {path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {(tooMany || tooBig) && (
              <p className="text-sm text-destructive">
                {tooMany
                  ? `At most ${MAX_FILES} code files at once.`
                  : `At most ${formatBytes(MAX_BYTES)} of code at once.`}
              </p>
            )}
            {problems.length > 0 && <ProblemList problems={problems} />}
          </div>
        )}

        <DialogFooter>
          {results ? (
            <Button onClick={() => setOpen(false)}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <ActionButton
                onClick={submit}
                state={uploading.state}
                onReset={uploading.reset}
                pendingLabel="Uploading"
                doneLabel="Uploaded"
                disabled={
                  uploading.state === "idle" &&
                  (picked.length === 0 ||
                    tooMany ||
                    tooBig ||
                    (mode.kind === "version" && !entry))
                }
              >
                <Upload />
                Upload
              </ActionButton>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PickButton({
  directory,
  multiple,
  onPick,
  children,
}: {
  directory?: boolean
  multiple?: boolean
  onPick: (files: Picked[]) => void
  children: React.ReactNode
}) {
  const input = React.useRef<HTMLInputElement>(null)
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => input.current?.click()}
      >
        {children}
      </Button>
      <input
        ref={input}
        type="file"
        className="hidden"
        multiple={multiple || directory}
        accept={directory ? undefined : ".tsx,.ts,.jsx,.js,.json"}
        // ⚠ NOT IN REACT'S TYPES, AND SUPPORTED BY EVERY CURRENT BROWSER,
        // Safari on iOS included (which then offers Files).
        {...(directory ? { webkitdirectory: "" } : {})}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])].map((file) => ({
            path: file.webkitRelativePath || file.name,
            file,
          }))
          event.target.value = ""
          onPick(files)
        }}
      />
    </>
  )
}

const OUTCOME: Record<
  TemplateUploadOutcome["outcome"],
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  created: { label: "Created", variant: "default" },
  versioned: { label: "New version", variant: "default" },
  unchanged: { label: "Unchanged", variant: "secondary" },
  refused: { label: "Not accepted", variant: "destructive" },
  unavailable: { label: "Try again", variant: "outline" },
}

function Results({
  results,
  problems,
}: {
  results: TemplateUploadOutcome[]
  problems: string[]
}) {
  return (
    <div className="space-y-3">
      {problems.length > 0 && <ProblemList problems={problems} />}
      <ul className="max-h-[24rem] divide-y overflow-auto rounded-lg border">
        {results.map((r) => (
          <li key={r.path} className="space-y-1.5 px-3 py-2.5">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                {r.template_id && r.outcome !== "refused" ? (
                  <Link
                    href={`/templates/${r.template_id}`}
                    className="truncate font-mono text-xs font-medium underline-offset-4 hover:underline"
                  >
                    {r.name}
                  </Link>
                ) : (
                  <p className="truncate font-mono text-xs font-medium">{r.name}</p>
                )}
                <p className="truncate font-mono text-2xs text-muted-foreground">
                  {r.path}
                </p>
              </div>
              {"version" in r && (
                <span className="tabular font-mono text-2xs text-muted-foreground">
                  v{r.version}
                </span>
              )}
              <Badge variant={OUTCOME[r.outcome].variant}>
                {OUTCOME[r.outcome].label}
              </Badge>
            </div>
            {r.outcome === "refused" && <ProblemList problems={r.problems} />}
            {r.outcome === "unavailable" && (
              <p className="text-xs text-muted-foreground">{r.message}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * ⚠ EVERY PROBLEM, IN FULL. The gate's sentences name the variable and quote
 * where it went wrong; "the template was refused" would send somebody hunting
 * through a file for a reason we already had.
 */
function ProblemList({ problems }: { problems: string[] }) {
  return (
    <ul className="space-y-1 rounded-md bg-destructive/5 px-3 py-2 text-xs text-destructive">
      {problems.map((p, i) => (
        <li key={i} className="break-words">
          {p}
        </li>
      ))}
    </ul>
  )
}

function problemsOf(body: Record<string, unknown> | undefined): string[] | null {
  const list = body?.problems
  return Array.isArray(list) &&
    list.every((p) => typeof p === "string") &&
    list.length > 0
    ? list
    : null
}

const CODE = /\.(tsx|ts|jsx|js)$/

function keepCode(files: Picked[]): Picked[] {
  return files.filter(
    ({ path }) =>
      (CODE.test(path) || path === "i10.json") &&
      !path.split("/").some((part) => part === "node_modules" || part.startsWith(".")),
  )
}

/** Drops a first directory every path shares: the picked folder's own name. */
function stripCommonRoot(files: Picked[]): Picked[] {
  const paths = files.map((f) => f.path.replace(/^\/+/, ""))
  const first = paths[0]?.split("/")[0]
  const shared =
    first !== undefined &&
    paths.every((p) => p.includes("/") && p.split("/")[0] === first)
  return files.map((f, i) => ({
    file: f.file,
    path: shared ? paths[i]!.slice(first!.length + 1) : paths[i]!,
  }))
}

/**
 * How many of the files the API will take as templates, by the same test:
 * a default export that sets `PreviewProps` (or what `i10.json` lists).
 * Only a count for the person to check; the API decides.
 */
async function countTemplates(files: Picked[]): Promise<number> {
  const manifest = files.find((f) => f.path === "i10.json")
  if (manifest) {
    try {
      const listed = (JSON.parse(await manifest.file.text()) as { templates?: unknown })
        .templates
      return Array.isArray(listed) ? listed.length : 0
    } catch {
      return 0
    }
  }
  let n = 0
  for (const { path, file } of files) {
    if (!/\.(tsx|jsx)$/.test(path) || path.split("/").some((d) => d.startsWith("_")))
      continue
    const text = await file.text()
    if (/\bexport\s+default\b/.test(text) && /\.PreviewProps\s*=/.test(text)) n++
  }
  return n
}

function stem(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1)
  return file.slice(0, file.lastIndexOf("."))
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Every file in a drop, walking into dropped folders. */
async function dropped(data: DataTransfer): Promise<Picked[]> {
  const roots = [...data.items]
    .map((item) => item.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null)
  const out: Picked[] = []
  async function walk(entry: FileSystemEntry): Promise<void> {
    if (out.length > MAX_FILES * 4) return
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      )
      out.push({ path: entry.fullPath.replace(/^\/+/, ""), file })
      return
    }
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // readEntries answers in batches until it answers with none.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      )
      if (batch.length === 0) break
      for (const child of batch) await walk(child)
    }
  }
  for (const root of roots) await walk(root)
  return out
}
