import type { Hono } from "hono"
import { closureOf, normalizePath, pick, readFileSet } from "@repo/templates"
import type { CompileInput } from "../../templates/renderer.js"
import { uploadTemplates } from "../../templates/upload.js"
import type { ConsoleDeps } from "./deps.js"
import {
  asNullableString,
  isRecord,
  notFound,
  notWired,
  readJson,
  validation,
} from "./http.js"

/**
 * The workspace's templates and their versions (#160, #161).
 *
 * ⚠ THE DRAFT IS SAVED ON EVERY KEYSTROKE AND CHANGES NOTHING THAT IS SENT.
 * What a send uses is a version, and only three things make one live: publish,
 * an upload, and promote. See templates/store.ts.
 *
 * ⚠ AND ONLY AN UPLOAD RUNS ANYTHING. `POST /templates/:id/versions` sends the
 * `.tsx` to the sandbox Worker, once; everything else here - previews
 * included - reads the stored rendering.
 */
export function mountTemplates(app: Hono, d: ConsoleDeps): void {
  const conflict = () => ({
    statusCode: 409 as const,
    name: "template_already_exists" as const,
    message: "A template with that name already exists.",
  })
  const unprocessable = (problems: string[]) => ({
    statusCode: 422 as const,
    name: "validation_error" as const,
    message: problems[0] ?? "The template could not be used.",
    problems,
  })
  const versionNumber = (raw: string) => {
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
  }

  app.get("/templates", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    return c.json({ data: await d.templates.list(c.get("auth").tenantId) })
  })

  app.post("/templates", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const body = await readJson(c)
    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (!name) return c.json(validation("`name` is required."), 422)
    const kind = body?.kind === "tsx" ? "tsx" : "html"
    const created = await d.templates.create(c.get("auth").tenantId, {
      name,
      folder: asNullableString(body?.folder),
      kind,
    })
    return "conflict" in created ? c.json(conflict(), 409) : c.json(created, 201)
  })

  app.get("/templates/:id", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const found = await d.templates.get(c.get("auth").tenantId, c.req.param("id"))
    return found ? c.json(found) : c.json(notFound("No template with that id."), 404)
  })

  app.patch("/templates/:id", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const body = await readJson(c)
    const updated = await d.templates.update(
      c.get("auth").tenantId,
      c.req.param("id"),
      {
        ...(typeof body?.name === "string" ? { name: body.name } : {}),
        ...(body?.folder !== undefined
          ? { folder: asNullableString(body.folder) }
          : {}),
        ...(body?.subject !== undefined
          ? { subject: asNullableString(body.subject) }
          : {}),
        ...(body?.html !== undefined ? { html: asNullableString(body.html) } : {}),
        ...(body?.text !== undefined ? { text: asNullableString(body.text) } : {}),
      },
    )
    if (updated && "conflict" in updated) return c.json(conflict(), 409)
    return updated
      ? c.json(updated)
      : c.json(notFound("No template with that id."), 404)
  })

  /**
   * ⚠ PUBLISHING IS A SEPARATE ACT FROM SAVING, AND THAT IS THE WHOLE DESIGN OF
   * THIS RESOURCE. A template is referenced from production code that is
   * sending mail right now; this is what turns the draft into a new version and
   * makes it the one unpinned sends get.
   */
  app.post("/templates/:id/publish", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const published = await d.templates.publish(
      c.get("auth").tenantId,
      c.req.param("id"),
    )
    if (!published) return c.json(notFound("No template with that id."), 404)
    if ("problems" in published) return c.json(unprocessable(published.problems), 422)
    return c.json(published)
  })

  /**
   * Uploads a React Email template as a new version, and makes it live.
   *
   * Either one file, `{ source }`, or a template and the files it imports,
   * `{ entry, files }` (#234). Files the entry never imports are ignored.
   *
   * ⚠ THE ONE ROUTE THAT RUNS CUSTOMER CODE, AND IT RUNS IT ELSEWHERE. The
   * source goes to the sandbox Worker, which renders it once and says whether
   * it only inserts its variables; this process never evaluates it. A refusal
   * comes back as 422 with every reason, for the author to fix.
   *
   * ⚠ THE SAME FILES AS THE LIVE VERSION MAKE NO NEW ONE, and the answer is
   * the live version with `unchanged: true` and a 200 rather than a 201.
   */
  app.post("/templates/:id/versions", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    if (!d.templateRenderer) return c.json(notWired("React Email templates"), 501)
    const { tenantId } = c.get("auth")
    const id = c.req.param("id")
    const body = await readJson(c)

    let input: CompileInput & { entry?: string }
    if (body?.files !== undefined) {
      const read = readFileSet(body.files)
      if (!read.ok) return c.json(unprocessable(read.problems), 422)
      const entry = typeof body.entry === "string" ? normalizePath(body.entry) : null
      if (!entry) return c.json(validation("`entry` names the template's file."), 422)
      const closure = closureOf(entry, read.files)
      if (closure.problems.length > 0) {
        return c.json(unprocessable(closure.problems), 422)
      }
      input = { entry, files: pick(read.files, closure.paths) }
    } else {
      const source = typeof body?.source === "string" ? body.source : ""
      if (!source.trim()) {
        return c.json(validation("`source`, or `entry` and `files`, is required."), 422)
      }
      input = { source }
    }

    // Before the sandbox, so an upload to a template that is not there costs
    // nothing.
    const template = await d.templates.identity(tenantId, id)
    if (!template || template.id !== id) {
      return c.json(notFound("No template with that id."), 404)
    }
    if (template.source === "github") {
      return c.json(
        unprocessable([
          "This template is kept in a GitHub repository. Push to its repository to change it.",
        ]),
        422,
      )
    }

    const compiled = await d.templateRenderer.compile(input)
    if (!compiled.ok) {
      return "problems" in compiled
        ? c.json(unprocessable(compiled.problems), 422)
        : c.json(
            {
              statusCode: 503 as const,
              name: "internal_server_error" as const,
              message:
                "Templates cannot be rendered right now. Try the upload again shortly.",
            },
            503,
          )
    }

    const version = await d.templates.createRenderedVersion(tenantId, id, {
      ...("files" in input
        ? { entry: input.entry, source: input.files[input.entry]!, files: input.files }
        : { source: input.source }),
      skeleton: compiled.skeleton,
      runtime: compiled.runtime,
      subject: compiled.subject,
      origin: "upload",
    })
    if (!version) return c.json(notFound("No template with that id."), 404)
    return c.json(version, version.unchanged ? 200 : 201)
  })

  /**
   * A folder of templates, or several `.tsx` files at once (#234): every
   * template in it created or given a new version, each on its own. See
   * templates/upload.ts.
   *
   * ⚠ 200 WITH REFUSALS INSIDE, NOT 422. The request did what it could, and the
   * answer lists what happened to each template; only an upload with nothing
   * usable in it at all is a 422.
   */
  app.post("/templates/upload", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    if (!d.templateRenderer) return c.json(notWired("React Email templates"), 501)
    const body = await readJson(c)
    const result = await uploadTemplates(
      { templates: d.templates, renderer: d.templateRenderer },
      c.get("auth").tenantId,
      body?.files,
    )
    return result.ok
      ? c.json({ data: result.data, problems: result.problems })
      : c.json(unprocessable(result.problems), 422)
  })

  app.get("/templates/:id/versions/:number", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const number = versionNumber(c.req.param("number"))
    const found =
      number === null
        ? null
        : await d.templates.version(c.get("auth").tenantId, c.req.param("id"), number)
    return found ? c.json(found) : c.json(notFound("No such version."), 404)
  })

  /** Makes an existing version live - rolling back is promoting an older one. */
  app.post("/templates/:id/versions/:number/promote", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const number = versionNumber(c.req.param("number"))
    const promoted =
      number === null
        ? null
        : await d.templates.promote(c.get("auth").tenantId, c.req.param("id"), number)
    return promoted ? c.json(promoted) : c.json(notFound("No such version."), 404)
  })

  /**
   * A version filled with its sample values, or with the caller's.
   *
   * ⚠ A POST BECAUSE IT CARRIES VARIABLES, NOT BECAUSE IT WRITES. It reads the
   * stored skeleton and fills it - exactly what a send does - so the preview
   * is the email, not an approximation of it.
   */
  app.post("/templates/:id/versions/:number/preview", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const number = versionNumber(c.req.param("number"))
    const body = await readJson(c)
    const variables = isRecord(body?.variables) ? body.variables : undefined
    const preview =
      number === null
        ? null
        : await d.templates.preview(
            c.get("auth").tenantId,
            c.req.param("id"),
            number,
            variables,
          )
    return preview ? c.json(preview) : c.json(notFound("No such version."), 404)
  })

  app.delete("/templates/:id", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const ok = await d.templates.delete(c.get("auth").tenantId, c.req.param("id"))
    return ok
      ? c.json({ id: c.req.param("id"), deleted: true })
      : c.json(notFound(), 404)
  })
}
