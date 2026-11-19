import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type { TemplateFolder, TemplateSummary } from "@/lib/types"

export interface TemplateFolderData {
  folderId: string
  folder: TemplateFolder | null
  templates: TemplateSummary[]
  folders?: TemplateFolder[]
  assetsOrigin?: string | null
  view?: "grid" | "table"
  error?: string
}

export interface TemplateFolderShape {
  /** Number of templates in this folder to draw, capped. */
  templates: number
  /** Grid vs table layout. */
  view: "grid" | "table"
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

export function templateFolderShape(folderId: string) {
  return defineShape<TemplateFolderShape, TemplateFolderData>({
    page: `templates-${folderId}`,
    fallback: {
      templates: 3,
      view: "grid",
    },
    of: ({ templates, view, folderId: fid }) => ({
      templates: Math.min(
        templates.filter((t) => t.folder_id === fid).length,
        MAX_SKELETON_ROWS,
      ),
      view: view ?? "grid",
    }),
    parse: (raw) => {
      if (typeof raw !== "object" || raw === null) return null
      const r = raw as Record<string, unknown>
      const templates = count(r.templates, MAX_SKELETON_ROWS)
      if (templates === null) return null
      return {
        templates,
        view: r.view === "table" ? "table" : "grid",
      }
    },
  })
}
