import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import { pathTo } from "@/lib/template-tree"
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
  /** Number of templates directly in this folder to draw, capped. */
  templates: number
  /** Number of folders directly in this folder to draw, capped. */
  folders: number
  /** How many folders are above this one: the crumbs before its name. */
  depth: number
  /** Grid vs table layout. */
  view: "grid" | "table"
}

/** More crumbs than the breadcrumb ever draws apart: it folds the middle. */
const MAX_DEPTH = 6

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

export function templateFolderShape(folderId: string) {
  return defineShape<TemplateFolderShape, TemplateFolderData>({
    page: `templates-${folderId}`,
    fallback: {
      templates: 3,
      folders: 0,
      depth: 0,
      view: "grid",
    },
    of: ({ templates, folders = [], view, folderId: fid }) => ({
      templates: Math.min(
        templates.filter((t) => t.folder_id === fid).length,
        MAX_SKELETON_ROWS,
      ),
      folders: Math.min(
        folders.filter((f) => f.parent_id === fid).length,
        MAX_SKELETON_ROWS,
      ),
      depth: Math.min(Math.max(pathTo(folders, fid).length - 1, 0), MAX_DEPTH),
      view: view ?? "grid",
    }),
    parse: (raw) => {
      if (typeof raw !== "object" || raw === null) return null
      const r = raw as Record<string, unknown>
      const templates = count(r.templates, MAX_SKELETON_ROWS)
      if (templates === null) return null
      return {
        templates,
        // A cookie from before folders nested has neither: the page was flat.
        folders: count(r.folders, MAX_SKELETON_ROWS) ?? 0,
        depth: count(r.depth, MAX_DEPTH) ?? 0,
        view: r.view === "table" ? "table" : "grid",
      }
    },
  })
}
