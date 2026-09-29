import { FileCode2, GitBranch, PenLine } from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import type { TemplateSource, TemplateVersionSummary } from "@/lib/types"

/**
 * Where a template is maintained (#234), as a badge.
 *
 * ⚠ IT SAYS WHERE TO GO TO CHANGE IT. A GitHub template edited here would be
 * overwritten by the next push, and an uploaded one has no draft to edit: the
 * badge is the first answer to "why can't I type in this?".
 */
export const SOURCE: Record<TemplateSource, { label: string; icon: typeof PenLine }> = {
  managed: { label: "Editor", icon: PenLine },
  upload: { label: "Upload", icon: FileCode2 },
  github: { label: "GitHub", icon: GitBranch },
}

export function SourceBadge({ source }: { source: TemplateSource }) {
  const { label, icon: Icon } = SOURCE[source]
  return (
    <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
      <Icon className="size-3" />
      {label}
    </Badge>
  )
}

/** What made a version, in the words a person would use. */
export function versionOrigin(v: TemplateVersionSummary): string {
  if (v.commit_sha)
    return `Commit ${v.commit_sha.slice(0, 7)}${v.path ? ` · ${v.path}` : ""}`
  if (v.kind === "tsx") return v.path ? `Uploaded ${v.path}` : "Uploaded"
  return "Published"
}
