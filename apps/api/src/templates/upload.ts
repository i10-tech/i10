import {
  closureOf,
  discoverTemplates,
  pick,
  readFileSet,
  type Discovered,
  type FileSet,
} from "@repo/templates"
import type { Renderer } from "./renderer.js"
import { fileSetHash, type TemplateIdentity, type TemplateStore } from "./store.js"

/**
 * Uploading a folder of templates, or a handful of `.tsx` files (#234).
 *
 * ⚠ EACH TEMPLATE SUCCEEDS OR FAILS ON ITS OWN. A folder of twelve with one
 * that uses a variable as a condition is eleven new versions and one refusal
 * with its reason, not twelve refusals. The answer lists every template and
 * what happened to it, because "some of them failed" is not something anybody
 * can act on.
 *
 * ⚠ AN UPLOAD ONLY EVER TOUCHES UPLOADED TEMPLATES. A file named like a
 * template written in the dash, or one kept in GitHub, is refused rather than
 * versioned on top of it: the name matching is a coincidence far more often
 * than it is an intent, and the other two have their own way to change.
 */

export type UploadOutcome = {
  path: string
  name: string
  folder: string | null
  template_id: string | null
} & (
  | { outcome: "created" | "versioned" | "unchanged"; version: number }
  | { outcome: "refused"; problems: string[] }
  /** The renderer could not be reached; the same upload can be tried again. */
  | { outcome: "unavailable"; message: string }
)

export type UploadResult =
  | { ok: true; data: UploadOutcome[]; problems: string[] }
  | { ok: false; problems: string[] }

const UNAVAILABLE =
  "Templates cannot be rendered right now. Try the upload again shortly."

const NO_TEMPLATES =
  "No templates were found. A template is a .tsx file with a default export that " +
  "sets PreviewProps, or a path listed in i10.json."

export async function uploadTemplates(
  deps: { templates: TemplateStore; renderer: Renderer },
  tenantId: string,
  input: unknown,
): Promise<UploadResult> {
  const read = readFileSet(input)
  if (!read.ok) return read
  const found = discoverTemplates(read.files)
  if (found.templates.length === 0) {
    return { ok: false, problems: [...found.problems, NO_TEMPLATES] }
  }

  const data: UploadOutcome[] = []
  let reachable = true
  // One at a time: the renderer is one small pod, and a person is waiting on
  // the whole list, not on its first answer.
  for (const template of found.templates) {
    if (!reachable) {
      data.push({
        ...base(template, null),
        outcome: "unavailable",
        message: UNAVAILABLE,
      })
      continue
    }
    const outcome = await uploadOne(deps, tenantId, template, read.files)
    if (outcome.outcome === "unavailable") reachable = false
    data.push(outcome)
  }
  return { ok: true, data, problems: found.problems }
}

async function uploadOne(
  deps: { templates: TemplateStore; renderer: Renderer },
  tenantId: string,
  template: Discovered,
  all: FileSet,
): Promise<UploadOutcome> {
  const existing = await deps.templates.identity(tenantId, template.name)
  const refused = (problems: string[]): UploadOutcome => ({
    ...base(template, existing?.id ?? null),
    outcome: "refused",
    problems,
  })

  if (existing && existing.source !== "upload") return refused([notOurs(existing)])

  const closure = closureOf(template.path, all)
  if (closure.problems.length > 0) return refused(closure.problems)
  const files = pick(all, closure.paths)

  // Checked before the sandbox, so an unchanged template costs no render.
  if (existing && existing.live_sha256 === fileSetHash(template.path, files)) {
    return {
      ...base(template, existing.id),
      outcome: "unchanged",
      version: existing.live_number,
    }
  }

  const compiled = await deps.renderer.compile({ entry: template.path, files })
  if (!compiled.ok) {
    return "problems" in compiled
      ? refused(compiled.problems)
      : {
          ...base(template, existing?.id ?? null),
          outcome: "unavailable",
          message: UNAVAILABLE,
        }
  }

  // Created only once there is a version to put in it, so a refused file
  // leaves no empty template behind.
  let id = existing?.id
  if (!id) {
    const created = await deps.templates.create(tenantId, {
      name: template.name,
      folder: template.folder,
      kind: "tsx",
      source: "upload",
    })
    if ("conflict" in created) {
      // Made by somebody else between our look and our create.
      const now = await deps.templates.identity(tenantId, template.name)
      if (!now || now.source !== "upload") {
        return refused([now ? notOurs(now) : "The template could not be created."])
      }
      id = now.id
    } else id = created.id
  }

  const version = await deps.templates.createRenderedVersion(tenantId, id, {
    entry: template.path,
    source: files[template.path]!,
    files,
    skeleton: compiled.skeleton,
    runtime: compiled.runtime,
    subject: compiled.subject,
    origin: "upload",
  })
  if (!version) return refused(["The template was deleted while it was uploading."])
  return {
    ...base(template, id),
    outcome: version.unchanged ? "unchanged" : existing ? "versioned" : "created",
    version: version.number,
  }
}

function base(template: Discovered, id: string | null) {
  return {
    path: template.path,
    name: template.name,
    folder: template.folder,
    template_id: id,
  }
}

function notOurs(existing: TemplateIdentity): string {
  return existing.source === "github"
    ? `\`${existing.name}\` is kept in a GitHub repository; change it there, or rename this file.`
    : `\`${existing.name}\` is a template made in the editor; rename this file, or the template.`
}
