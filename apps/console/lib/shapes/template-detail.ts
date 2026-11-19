import { defineShape } from "@/lib/shapes"
import type { TemplateDetail, TemplateSource } from "@/lib/types"

export interface TemplateDetailData {
  template: TemplateDetail
  tab?: string
  restored?: string
}

export interface TemplateDetailShape {
  source: TemplateSource
  kind: "html" | "tsx" | "visual"
  versions: number
  live: boolean
  github: boolean
  removed: boolean
  folder: boolean
  /** Whether it has a title, which puts its file name under it. */
  titled: boolean
  tab: string
}

export const templateDetailShape = defineShape<TemplateDetailShape, TemplateDetailData>(
  {
    page: "template",
    fallback: {
      source: "upload",
      kind: "tsx",
      versions: 1,
      live: true,
      github: false,
      removed: false,
      folder: false,
      titled: false,
      tab: "preview",
    },
    of: ({ template, tab }) => ({
      source: template.source,
      kind: template.kind,
      versions: Math.min(template.versions, 10),
      live: template.history.some((v) => v.live),
      github: Boolean(template.github),
      removed: Boolean(template.github?.removed),
      folder: Boolean(template.folder_id),
      titled: Boolean(template.title),
      tab: tab ?? "preview",
    }),
    parse: (raw) => {
      if (typeof raw !== "object" || raw === null) return null
      const r = raw as Record<string, unknown>
      const source =
        r.source === "managed" || r.source === "upload" || r.source === "github"
          ? r.source
          : null
      const kind =
        r.kind === "html" || r.kind === "tsx" || r.kind === "visual" ? r.kind : null
      if (!source || !kind) return null
      return {
        source,
        kind,
        versions: typeof r.versions === "number" && r.versions >= 0 ? r.versions : 1,
        live: r.live === true,
        github: r.github === true,
        removed: r.removed === true,
        folder: r.folder === true,
        // Cookies written before this field existed read as "untitled".
        titled: r.titled === true,
        tab: typeof r.tab === "string" ? r.tab : "preview",
      }
    },
  },
)
