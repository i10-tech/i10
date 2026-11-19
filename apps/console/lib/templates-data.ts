import "server-only"
import { cookies } from "next/headers"
import { tryApi } from "@/lib/api"
import { viewCookie } from "@/lib/views"
import type { TemplatesData } from "@/lib/shapes/templates"
import type { TemplateFolderData } from "@/lib/shapes/template-folder"
import type {
  GithubState,
  TemplateFolder,
  TemplateSummary,
  TrustedTemplateRow,
} from "@/lib/types"

/**
 * What the templates pages draw, read once per request.
 *
 * ⚠ ONE READ FOR THE PAGE AND FOR ITS REVISIT CHECK (lib/kept-pages.ts). The check
 * tells whether the page changed by fingerprinting this same value, so a page
 * that read anything more than this would look unchanged when it was not.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Library = {
  data: TemplateSummary[]
  folders?: TemplateFolder[]
  assets_origin?: string | null
}

export async function loadTemplates(): Promise<TemplatesData> {
  const [result, trusted, github, cookieStore] = await Promise.all([
    tryApi<Library>("/console/templates"),
    tryApi<{ data: TrustedTemplateRow[] }>("/console/trusted-templates"),
    tryApi<GithubState>("/console/github"),
    cookies(),
  ])
  const view = cookieStore.get(viewCookie("templates"))?.value
  return {
    templates: result.ok ? result.data.data : [],
    folders: result.ok ? (result.data.folders ?? []) : [],
    assetsOrigin: result.ok ? (result.data.assets_origin ?? null) : null,
    github: github.ok ? github.data : null,
    trusted: trusted.ok ? trusted.data.data : null,
    view: view === "table" ? "table" : "grid",
    ...(result.ok ? {} : { error: result.error.message }),
  }
}

/** One folder's page, or null when there is no such folder. Throws when the API fails. */
export async function loadTemplateFolder(
  id: string,
): Promise<TemplateFolderData | null> {
  if (!UUID.test(id)) return null
  const [result, cookieStore] = await Promise.all([
    tryApi<Library>("/console/templates"),
    cookies(),
  ])
  if (!result.ok) throw new Error(result.error.message)
  const folders = result.data.folders ?? []
  const folder = folders.find((f) => f.id === id)
  if (!folder) return null
  const view =
    cookieStore.get(viewCookie(`templates-${id}`))?.value ??
    cookieStore.get(viewCookie("templates"))?.value
  return {
    folderId: id,
    folder,
    templates: result.data.data.filter((t) => t.folder_id === id),
    folders,
    assetsOrigin: result.data.assets_origin ?? null,
    view: view === "table" ? "table" : "grid",
  }
}

/** The folder's name, for its tab title. */
export async function templateFolderNamed(id: string): Promise<TemplateFolder | null> {
  if (!UUID.test(id)) return null
  const result = await tryApi<{ folders?: TemplateFolder[] }>("/console/templates")
  return result.ok
    ? ((result.data.folders ?? []).find((f) => f.id === id) ?? null)
    : null
}
