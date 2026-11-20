import { defineShape } from "@/lib/shapes"
import { MAX_SKELETON_ROWS } from "@/lib/list-counts"
import type {
  GithubState,
  TemplateFolder,
  TemplateSummary,
  TrustedTemplateRow,
} from "@/lib/types"

export interface TemplatesData {
  templates: TemplateSummary[]
  folders: TemplateFolder[]
  assetsOrigin?: string | null
  github?: GithubState | null
  trusted?: TrustedTemplateRow[] | null
  view?: "grid" | "table"
  error?: string
}

export interface TemplatesShape {
  /** Number of root templates to draw, capped; 0 is empty. */
  templates: number
  /** Number of top-level folders to draw, capped. */
  folders: number
  /** Grid vs table layout. */
  view: "grid" | "table"
  /** Whether GitHub integration panel is shown. */
  github: boolean
  /** The GitHub App is installed on an account, so the panel offers a repository. */
  githubInstalled: boolean
  /** Repositories connected, capped. */
  githubRepos: number
  /**
   * Number of trusted/reviewed templates, capped; 0 is none. Null is UNKNOWN:
   * the skeleton draws a neutral row, never "Nothing submitted yet" for a
   * workspace that may have submissions.
   */
  trusted: number | null
}

const count = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : null

const templatesShapeFallback: TemplatesShape = {
  templates: 4,
  folders: 0,
  view: "grid",
  github: false,
  githubInstalled: false,
  githubRepos: 0,
  trusted: null,
}

export const templatesShape = defineShape<TemplatesShape, TemplatesData>({
  page: "templates",
  fallback: templatesShapeFallback,
  // A first visit's counts (GET /console/shapes); what a count cannot know
  // keeps the default. ⚠ AN API THAT PREDATES `templateFolders` SENT ONE SUM OF
  // ROOT TEMPLATES AND FOLDERS UNDER `templates`, which stays the cards drawn.
  fromCounts: (counts) => {
    const templates = count(counts.templates, MAX_SKELETON_ROWS)
    if (templates === null) return null
    return {
      ...templatesShapeFallback,
      templates,
      folders: count(counts.templateFolders, MAX_SKELETON_ROWS) ?? 0,
      github: counts.githubConfigured === 1,
      githubInstalled: (count(counts.githubInstallations, 1) ?? 0) > 0,
      githubRepos: count(counts.githubRepos, MAX_SKELETON_ROWS) ?? 0,
      trusted: count(counts.trustedTemplates, MAX_SKELETON_ROWS),
    }
  },
  of: ({ templates, folders, github, trusted, view }) => ({
    templates: Math.min(
      templates.filter((t) => t.folder_id === null).length,
      MAX_SKELETON_ROWS,
    ),
    folders: Math.min(
      folders.filter((f) => f.parent_id === null).length,
      MAX_SKELETON_ROWS,
    ),
    view: view ?? "grid",
    github: github?.configured === true,
    githubInstalled: (github?.installations.length ?? 0) > 0,
    githubRepos: Math.min(github?.repositories.length ?? 0, MAX_SKELETON_ROWS),
    trusted: trusted ? Math.min(trusted.length, MAX_SKELETON_ROWS) : 0,
  }),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null
    const r = raw as Record<string, unknown>
    const templates = count(r.templates, MAX_SKELETON_ROWS)
    const folders = count(r.folders, MAX_SKELETON_ROWS)
    const trusted = count(r.trusted, MAX_SKELETON_ROWS)
    const githubRepos = count(r.githubRepos, MAX_SKELETON_ROWS)
    // null is a real trusted value here (unknown), so only a bad non-null drops it.
    if (
      templates === null ||
      folders === null ||
      (trusted === null && r.trusted !== null) ||
      githubRepos === null
    )
      return null
    return {
      templates,
      folders,
      view: r.view === "table" ? "table" : "grid",
      github: r.github === true,
      githubInstalled: r.githubInstalled === true,
      githubRepos,
      trusted,
    }
  },
})
