"use client"

import * as React from "react"
import Link from "next/link"
import { Search } from "lucide-react"
import { Badge } from "@repo/ui/components/badge"
import { Input } from "@repo/ui/components/input"
import { SourceBadge } from "@/components/template-source"
import { TemplateThumbnail } from "@/components/template-thumbnail"
import { formatRelative } from "@/lib/format"
import type { TemplateSummary } from "@/lib/types"

/**
 * The workspace's templates as cards, each showing the top of its live email
 * (#248), with search.
 *
 * ⚠ ONE GRID, WITH THE FOLDER WRITTEN ON THE CARD. Section headings per folder
 * left a single card per row whenever folders were small - most of the time -
 * and a grid of one is a list with extra padding. The API already orders by
 * folder and name, so cards of a folder still sit together; the path prefix
 * says which they are.
 *
 * ⚠ SEARCH FILTERS WHAT IS ALREADY HERE. The list is one capped response, so
 * a round trip per keystroke would buy nothing but latency.
 */
export function TemplateGrid({
  templates,
  imagesFrom,
}: {
  templates: TemplateSummary[]
  imagesFrom: string | null
}) {
  const [query, setQuery] = React.useState("")
  const q = query.trim().toLowerCase()
  const shown = q
    ? templates.filter((t) =>
        [t.name, t.subject ?? "", t.folder ?? ""].some((s) =>
          s.toLowerCase().includes(q),
        ),
      )
    : templates

  return (
    <div className="space-y-6">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search templates"
          aria-label="Search templates"
          className="pl-8"
        />
      </div>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No template matches “{query.trim()}”.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {shown.map((t) => (
            <li key={t.id}>
              <TemplateCard template={t} imagesFrom={imagesFrom} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TemplateCard({
  template,
  imagesFrom,
}: {
  template: TemplateSummary
  imagesFrom: string | null
}) {
  const t = template
  // ⚠ "UNPUBLISHED CHANGES" ONLY FOR EDITOR TEMPLATES. An upload or a push IS
  // a version, so for those the draft is never ahead of what is live.
  const status =
    t.published_at === null
      ? { label: "Never published", variant: "outline" as const }
      : t.source === "managed" && t.updated_at > t.published_at
        ? { label: "Unpublished changes", variant: "secondary" as const }
        : null

  return (
    <Link
      href={`/templates/${t.id}`}
      className="group block overflow-hidden rounded-xl border bg-card transition-colors duration-(--duration-instant) ease-(--ease-linear) hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <TemplateThumbnail
        templateId={t.id}
        version={t.version}
        imagesFrom={imagesFrom}
        label={`${t.name} preview`}
      />
      <div className="space-y-2 px-3 py-2.5">
        <div className="min-w-0">
          <p
            className="truncate font-mono text-xs font-medium"
            title={t.folder ? `${t.folder}/${t.name}` : t.name}
          >
            {t.folder && (
              <span className="font-normal text-muted-foreground">{t.folder}/</span>
            )}
            {t.name}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {t.subject || <em>No subject yet</em>}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <SourceBadge source={t.source} />
          {status && <Badge variant={status.variant}>{status.label}</Badge>}
          {t.version > 0 && (
            <span className="tabular font-mono text-2xs text-muted-foreground">
              v{t.version}
            </span>
          )}
          <span
            className="ml-auto text-2xs whitespace-nowrap text-muted-foreground"
            title={t.updated_at}
          >
            {formatRelative(t.updated_at)}
          </span>
        </div>
      </div>
    </Link>
  )
}
