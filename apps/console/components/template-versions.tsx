"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { diffLines, type Change } from "diff"
import { ArrowRight, Undo2 } from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { Button } from "@repo/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmailFrame } from "@/components/email-frame"
import { versionOrigin } from "@/components/template-source"
import { Time } from "@/components/time"
import {
  previewTemplateVersion,
  promoteTemplateVersion,
  templateVersion,
} from "@/lib/actions"
import type {
  TemplatePreview,
  TemplateVersionDetail,
  TemplateVersionSummary,
} from "@/lib/types"

/**
 * A template's versions: which one is live, what made each, and going back.
 *
 * ⚠ "MAKE LIVE" IS THE WHOLE OF ROLLING BACK. Versions are immutable, so an
 * older one is exactly what it was when it went out; promoting it is instant
 * and needs no rebuild, no sandbox and no repository. The newer versions stay,
 * so rolling forward again is the same click.
 */
export function TemplateVersions({
  templateId,
  history,
}: {
  templateId: string
  history: TemplateVersionSummary[]
}) {
  const router = useRouter()
  const [promoting, setPromoting] = React.useState<TemplateVersionSummary | null>(null)
  const live = history.find((v) => v.live)

  if (history.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-12 text-center text-sm text-muted-foreground">
        No versions yet. The first one is made when the template is published or
        uploaded.
      </p>
    )
  }

  return (
    <div className="space-y-10">
      <ul className="divide-y overflow-hidden rounded-lg border">
        {history.map((v) => (
          <li key={v.id} className="flex items-center gap-3 px-4 py-3">
            <span className="tabular w-10 shrink-0 font-mono text-xs font-medium">
              v{v.number}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                {v.subject || <em className="text-muted-foreground">No subject</em>}
              </p>
              <p className="truncate font-mono text-2xs text-muted-foreground">
                {versionOrigin(v)}
              </p>
            </div>
            {v.live && <Badge>Live</Badge>}
            <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
              <Time iso={v.created_at} />
            </span>
            <div className="w-28 shrink-0 text-right">
              {!v.live && (
                <Button variant="ghost" size="sm" onClick={() => setPromoting(v)}>
                  <Undo2 />
                  Make live
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {history.length > 1 && <VersionDiff templateId={templateId} history={history} />}

      <ConfirmDialog
        open={promoting !== null}
        onOpenChange={(open) => !open && setPromoting(null)}
        title={`Make v${promoting?.number ?? ""} live?`}
        description={
          `Every send that does not pin a version gets v${promoting?.number ?? ""} from ` +
          `now on${live ? `, instead of v${live.number}` : ""}. Sends that pin a version are unaffected, and you can switch back at any time.`
        }
        confirmLabel="Make live"
        doneLabel="Live"
        onConfirm={async () => {
          if (!promoting) return false
          const result = await promoteTemplateVersion(templateId, promoting.number)
          if (!result.ok) {
            toast.error("Could not make it live", { description: result.error })
            return false
          }
          router.refresh()
          return true
        }}
      />
    </div>
  )
}

/**
 * Two versions compared: what changed in the source, then how each looks.
 *
 * ⚠ THE HTML COMPARED IS THE READABLE FORM, `{{ name }}` WHERE VARIABLES GO.
 * Each version's markers carry its own random nonce, so the stored skeletons
 * differ at every variable even when nothing changed; the API writes them
 * back as placeholders so the diff shows only what the template changed.
 */
function VersionDiff({
  templateId,
  history,
}: {
  templateId: string
  history: TemplateVersionSummary[]
}) {
  const live = history.find((v) => v.live) ?? history[0]!
  const [to, setTo] = React.useState(live.number)
  const [from, setFrom] = React.useState(
    history.find((v) => v.number < live.number)?.number ??
      history.find((v) => v.number !== live.number)!.number,
  )
  const [pair, setPair] = React.useState<{
    a: TemplateVersionDetail
    b: TemplateVersionDetail
    pa: TemplatePreview | null
    pb: TemplatePreview | null
  } | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let current = true
    void (async () => {
      const [a, b, pa, pb] = await Promise.all([
        templateVersion(templateId, from),
        templateVersion(templateId, to),
        previewTemplateVersion(templateId, from),
        previewTemplateVersion(templateId, to),
      ])
      if (!current) return
      if (!a.ok || !b.ok) {
        setError(
          (!a.ok ? a.error : !b.ok ? b.error : null) ?? "Could not load versions.",
        )
        return
      }
      setError(null)
      setPair({
        a: a.data,
        b: b.data,
        pa: pa.ok ? pa.data : null,
        pb: pb.ok ? pb.data : null,
      })
    })()
    return () => {
      current = false
    }
  }, [templateId, from, to])

  const picker = (value: number, onChange: (n: number) => void, label: string) => (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-32" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {history.map((v) => (
          <SelectItem key={v.number} value={String(v.number)}>
            v{v.number}
            {v.live ? " · live" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const files = pair ? changedFiles(pair.a, pair.b) : []

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-sm font-medium">Compare</h2>
        {picker(from, setFrom, "Older version")}
        <ArrowRight className="size-4 text-muted-foreground" />
        {picker(to, setTo, "Newer version")}
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !pair ? (
        <div className="h-40 animate-pulse rounded-lg bg-muted/30" />
      ) : from === to ? (
        <p className="text-sm text-muted-foreground">Pick two different versions.</p>
      ) : (
        <>
          {files.length === 0 ? (
            <p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
              The two versions are identical.
            </p>
          ) : (
            <div className="space-y-4">
              {files.map((f) => (
                <FileDiff key={f.path} path={f.path} changes={f.changes} />
              ))}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {[
              { n: from, p: pair.pa },
              { n: to, p: pair.pb },
            ].map(({ n, p }) => (
              <figure key={n} className="overflow-hidden rounded-lg border">
                <figcaption className="border-b px-3 py-2 font-mono text-xs">
                  v{n}
                </figcaption>
                {p?.html ? (
                  <EmailFrame html={p.html} title={`v${n}`} className="h-[28rem]" />
                ) : (
                  <pre className="h-[28rem] overflow-auto bg-muted/30 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
                    {p?.text ?? ""}
                  </pre>
                )}
              </figure>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

/** Everything a version is made of, as named texts to compare. */
function textsOf(v: TemplateVersionDetail): Record<string, string> {
  const out: Record<string, string> = { Subject: v.subject ?? "" }
  if (v.kind === "tsx") {
    out[v.path ?? "template.tsx"] = v.source ?? ""
    for (const [path, text] of Object.entries(v.files ?? {})) out[path] = text
  } else {
    if (v.display.html !== null) out["HTML"] = v.display.html
    if (v.display.text !== null) out["Plain text"] = v.display.text
  }
  return out
}

function changedFiles(a: TemplateVersionDetail, b: TemplateVersionDetail) {
  const ta = textsOf(a)
  const tb = textsOf(b)
  const paths = [...new Set([...Object.keys(ta), ...Object.keys(tb)])]
  return paths
    .map((path) => ({ path, changes: diffLines(ta[path] ?? "", tb[path] ?? "") }))
    .filter((f) => f.changes.some((c) => c.added || c.removed))
}

const CONTEXT = 3

/**
 * One file's changes, unified, with unchanged runs folded to three lines
 * either side.
 *
 * ⚠ TEXT CHILDREN ONLY. The lines are the template's own source; React
 * escapes them, so a `<script>` in a diff is characters on screen.
 */
function FileDiff({ path, changes }: { path: string; changes: Change[] }) {
  const rows: {
    kind: " " | "+" | "-" | "…"
    text: string
    old?: number
    now?: number
  }[] = []
  let oldLine = 1
  let newLine = 1
  changes.forEach((change, index) => {
    const lines = change.value.replace(/\n$/, "").split("\n")
    if (change.added) {
      for (const text of lines) rows.push({ kind: "+", text, now: newLine++ })
    } else if (change.removed) {
      for (const text of lines) rows.push({ kind: "-", text, old: oldLine++ })
    } else {
      const first = index === 0
      const last = index === changes.length - 1
      const keepHead = first ? 0 : CONTEXT
      const keepTail = last ? 0 : CONTEXT
      if (lines.length <= keepHead + keepTail + 1) {
        for (const text of lines)
          rows.push({ kind: " ", text, old: oldLine++, now: newLine++ })
      } else {
        for (const text of lines.slice(0, keepHead))
          rows.push({ kind: " ", text, old: oldLine++, now: newLine++ })
        const skipped = lines.length - keepHead - keepTail
        rows.push({
          kind: "…",
          text: `${skipped} unchanged ${skipped === 1 ? "line" : "lines"}`,
        })
        oldLine += skipped
        newLine += skipped
        for (const text of lines.slice(lines.length - keepTail))
          rows.push({ kind: " ", text, old: oldLine++, now: newLine++ })
      }
    }
  })

  return (
    <div className="overflow-hidden rounded-lg border">
      <p className="border-b bg-muted/30 px-3 py-1.5 font-mono text-xs">{path}</p>
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {rows.map((row, i) =>
              row.kind === "…" ? (
                <tr key={i} className="bg-muted/20 text-muted-foreground">
                  <td colSpan={3} className="px-3 py-0.5 text-2xs">
                    {row.text}
                  </td>
                </tr>
              ) : (
                <tr
                  key={i}
                  className={
                    row.kind === "+"
                      ? "bg-success/10"
                      : row.kind === "-"
                        ? "bg-destructive/10"
                        : undefined
                  }
                >
                  <td className="tabular w-10 px-2 text-right text-muted-foreground select-none">
                    {row.old ?? ""}
                  </td>
                  <td className="tabular w-10 px-2 text-right text-muted-foreground select-none">
                    {row.now ?? ""}
                  </td>
                  <td className="px-2 whitespace-pre-wrap break-all">
                    <span className="mr-2 text-muted-foreground select-none">
                      {row.kind}
                    </span>
                    {row.text}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
