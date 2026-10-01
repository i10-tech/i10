import type { Hono } from "hono"
import { addressSchema } from "@repo/contracts"
import { closureOf, normalizePath, pick, readFileSet } from "@repo/templates"
import type { DeclaredVariable, TemplatePatch } from "../../templates/store.js"
import { addressOf, domainOf } from "../../send/address.js"
import type { CompileInput } from "../../templates/renderer.js"
import { uploadTemplates } from "../../templates/upload.js"
import type { ConsoleDeps } from "./deps.js"
import {
  asIdArray,
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

  const folderConflict = () => ({
    statusCode: 409 as const,
    name: "template_folder_already_exists" as const,
    message: "A folder with that name already exists.",
  })
  const folderName = (raw: unknown) => {
    const name = typeof raw === "string" ? raw.trim() : ""
    if (!name) return { problem: "Name the folder." }
    if (name.length > 100)
      return { problem: "Folder names are at most 100 characters." }
    return { name }
  }

  app.get("/templates", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const { tenantId } = c.get("auth")
    const [data, folders] = await Promise.all([
      d.templates.list(tenantId),
      d.templates.folders(tenantId),
    ])
    return c.json({
      data,
      folders,
      // Where our own template images load from, for previews' CSP (#248).
      assets_origin: d.templateAssets?.origin ?? null,
    })
  })

  // ── Folders ──────────────────────────────────────────────────────────────

  app.post("/template-folders", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const read = folderName((await readJson(c))?.name)
    if (read.problem !== undefined) return c.json(validation(read.problem), 422)
    const created = await d.templates.createFolder(c.get("auth").tenantId, read.name)
    return "conflict" in created ? c.json(folderConflict(), 409) : c.json(created, 201)
  })

  app.patch("/template-folders/:id", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const read = folderName((await readJson(c))?.name)
    if (read.problem !== undefined) return c.json(validation(read.problem), 422)
    const renamed = await d.templates.renameFolder(
      c.get("auth").tenantId,
      c.req.param("id"),
      read.name,
    )
    if (!renamed) return c.json(notFound("No folder with that id."), 404)
    return "conflict" in renamed ? c.json(folderConflict(), 409) : c.json(renamed)
  })

  /** Deletes a folder; its templates move to the top level, none is deleted. */
  app.delete("/template-folders/:id", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const ok = await d.templates.deleteFolder(c.get("auth").tenantId, c.req.param("id"))
    return ok
      ? c.json({ id: c.req.param("id"), deleted: true })
      : c.json(notFound("No folder with that id."), 404)
  })

  /** Files templates in a folder, or at the top level with `folder_id: null`. */
  app.post("/templates/move", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const body = await readJson(c)
    const ids = asIdArray(body?.ids)
    if (ids.length === 0) return c.json(validation("`ids` lists the templates."), 422)
    const folderId = typeof body?.folder_id === "string" ? body.folder_id : null
    const moved = await d.templates.move(c.get("auth").tenantId, ids, folderId)
    return moved === null
      ? c.json(notFound("No folder with that id."), 404)
      : c.json({ moved })
  })

  /** Deletes several templates; the answer lists the ids actually deleted. */
  app.post("/templates/delete", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const ids = asIdArray((await readJson(c))?.ids)
    if (ids.length === 0) return c.json(validation("`ids` lists the templates."), 422)
    const deleted = await d.templates.deleteMany(c.get("auth").tenantId, ids)
    return c.json({ deleted })
  })

  app.post("/templates/:id/duplicate", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const copy = await d.templates.duplicate(c.get("auth").tenantId, c.req.param("id"))
    return copy ? c.json(copy, 201) : c.json(notFound("No template with that id."), 404)
  })

  app.post("/templates", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const body = await readJson(c)
    // ⚠ NO NAME IS FINE: "New template" opens the editor at once, as Resend's
    // does, on `untitled-template` (then `-2`, `-3`…), titled "Untitled
    // Template". The alias and the title can both be changed later.
    const name = typeof body?.name === "string" ? body.name.trim() : ""
    const title =
      typeof body?.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, 200)
        : name
          ? null
          : "Untitled Template"
    const kind =
      body?.kind === "tsx" ? "tsx" : body?.kind === "visual" ? "visual" : "html"
    const created = await d.templates.create(c.get("auth").tenantId, {
      ...(name ? { name } : {}),
      title,
      folderId: asNullableString(body?.folder_id),
      kind,
    })
    return "conflict" in created ? c.json(conflict(), 409) : c.json(created, 201)
  })

  app.get("/templates/:id", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const found = await d.templates.get(c.get("auth").tenantId, c.req.param("id"))
    return found
      ? c.json({ ...found, assets_origin: d.templateAssets?.origin ?? null })
      : c.json(notFound("No template with that id."), 404)
  })

  app.patch("/templates/:id", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const body = await readJson(c)
    const patch = readPatch(body)
    if ("problem" in patch) return c.json(validation(patch.problem), 422)
    // ⚠ THE SENDER MUST BE ONE THIS WORKSPACE CAN SEND FROM, by the send
    // path's own rule. A template whose default From is refused at every send
    // is a broken template that looks finished.
    if (patch.from && d.sendableFrom) {
      const domain = domainOf(patch.from)?.toLowerCase() ?? ""
      const ok =
        domain !== "" &&
        (await d.sendableFrom(c.get("auth").tenantId, [domain])).has(domain)
      if (!ok) {
        return c.json(
          validation(
            `${domain || patch.from} is not a verified domain in this workspace. Verify it under Domains first.`,
          ),
          422,
        )
      }
    }
    const updated = await d.templates.update(
      c.get("auth").tenantId,
      c.req.param("id"),
      patch,
    )
    if (updated && "conflict" in updated) return c.json(conflict(), 409)
    if (updated && "problem" in updated) return c.json(validation(updated.problem), 422)
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

  /**
   * An image for a template (#244): the raw bytes in, a public URL out.
   *
   * ⚠ THE BODY IS THE FILE, NOT JSON. Base64 would add a third to the largest
   * thing this route takes; the type is read from the bytes either way, so
   * nothing the request says about itself is trusted.
   */
  app.post("/templates/assets", async (c) => {
    if (!d.templateAssets) return c.json(notWired("Template images"), 501)
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    const result = await d.templateAssets.upload(c.get("auth").tenantId, bytes)
    return result.ok
      ? c.json(result.asset, 201)
      : c.json(unprocessable([result.problem]), 422)
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

  /**
   * Sends the draft to an address, as Resend's "Test email" does: every
   * variable its fallback, or left as `{{ name }}` without one.
   *
   * ⚠ THE DRAFT, NOT THE LIVE VERSION, because a test is how somebody checks
   * what they are about to publish.
   */
  app.post("/templates/:id/test", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    if (!d.sendTest) return c.json(notWired("Test emails"), 501)
    const { tenantId } = c.get("auth")
    const body = await readJson(c)
    const to = (Array.isArray(body?.to) ? body.to : [body?.to])
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean)
    if (to.length === 0) return c.json(validation("Who should the test go to?"), 422)
    if (to.length > 5)
      return c.json(validation("A test goes to at most five addresses."), 422)
    const bad = to.find((a) => !isAddress(a))
    if (bad) return c.json(validation(`${bad} is not an email address.`), 422)

    const email = await d.templates.draftEmail(tenantId, c.req.param("id"))
    if (!email) return c.json(notFound("No template with that id."), 404)
    if ("problems" in email) return c.json(unprocessable(email.problems), 422)
    const from = (typeof body?.from === "string" && body.from.trim()) || email.from
    if (!from) {
      return c.json(
        validation("Set the template's From address, or give one for the test."),
        422,
      )
    }
    if (!isAddress(from)) {
      return c.json(validation(`${from} is not an email address.`), 422)
    }

    const outcome = await d.sendTest(tenantId, {
      from,
      to,
      subject: `[Test] ${email.subject || "(no subject)"}`,
      ...(email.html ? { html: email.html } : {}),
      ...(email.text ? { text: email.text } : {}),
      ...(email.reply_to && email.reply_to.length > 0
        ? { reply_to: email.reply_to }
        : {}),
      tags: [{ name: "template_test", value: "true" }],
    })
    if (outcome.status === "accepted")
      return c.json({ id: outcome.ids[0] ?? null }, 201)
    if (outcome.status === "replayed")
      return c.json({ id: outcome.ids[0] ?? null }, 200)
    return c.json(
      {
        statusCode: 422 as const,
        name: "validation_error" as const,
        message: "message" in outcome ? outcome.message : "The test could not be sent.",
      },
      422,
    )
  })

  /**
   * The draft filled as a test email would be, for the list's thumbnails:
   * what somebody is editing, not only what was last published.
   */
  app.get("/templates/:id/draft-preview", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const email = await d.templates.draftEmail(
      c.get("auth").tenantId,
      c.req.param("id"),
    )
    if (!email) return c.json(notFound("No template with that id."), 404)
    if ("problems" in email) return c.json({ html: null, subject: null, text: null })
    return c.json({ html: email.html, subject: email.subject, text: email.text })
  })

  app.delete("/templates/:id", async (c) => {
    if (!d.templates) return c.json(notWired("Templates"), 501)
    const ok = await d.templates.delete(c.get("auth").tenantId, c.req.param("id"))
    return ok
      ? c.json({ id: c.req.param("id"), deleted: true })
      : c.json(notFound(), 404)
  })
}

/**
 * A deliverable-looking address, `a@b.c` or `Name <a@b.c>`.
 *
 * ⚠ STRICTER THAN `addressSchema`, WHICH ONLY REFUSES WHAT WOULD INJECT A
 * HEADER. A template's sender and reply-to are typed into a form, not sent by
 * code, and "nope" saved as a reply-to would surface weeks later as replies
 * that go nowhere.
 */
function isAddress(value: string): boolean {
  if (!addressSchema.safeParse(value).success) return false
  const bare = addressOf(value)
  return !!bare && /^[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)*\.[A-Za-z]{2,}$/.test(bare)
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/**
 * What an alias may be. Not a uuid's shape, because a send's `template.id`
 * is read as an id when it looks like one.
 */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Resend's ceiling on a template's variables. */
const MAX_DECLARED = 50

/**
 * A draft edit from an untyped body, every field checked.
 *
 * ⚠ THE SENDER IS CHECKED HERE, NOT AT SEND. A send that relies on the
 * template's `from` cannot fix a malformed one; refusing it while somebody is
 * typing it is the only moment the person who can fix it is looking.
 */
function readPatch(
  body: Record<string, unknown> | null,
): TemplatePatch | { problem: string } {
  const patch: TemplatePatch = {}
  if (!body) return patch
  if (typeof body.name === "string") {
    const name = body.name.trim()
    if (!name) return { problem: "The alias cannot be empty." }
    if (!ALIAS.test(name) || UUID_SHAPE.test(name)) {
      return {
        problem:
          "An alias is letters, digits, dots, dashes and underscores, like password-reset.",
      }
    }
    patch.name = name
  }
  if (body.title !== undefined) {
    const title = asNullableString(body.title)?.trim() ?? null
    if (title !== null && title.length > 200)
      return { problem: "Titles are at most 200 characters." }
    patch.title = title || null
  }
  if (body.folder_id !== undefined) patch.folderId = asNullableString(body.folder_id)
  if (body.kind === "html" || body.kind === "visual") patch.kind = body.kind
  if (body.subject !== undefined) patch.subject = asNullableString(body.subject)
  if (body.from !== undefined) {
    const from = asNullableString(body.from)?.trim() || null
    if (from !== null && !isAddress(from)) {
      return { problem: "The sender is not an email address, like Acme <hi@acme.com>." }
    }
    patch.from = from
  }
  if (body.reply_to !== undefined) {
    const raw = Array.isArray(body.reply_to)
      ? body.reply_to
      : typeof body.reply_to === "string"
        ? body.reply_to.split(",")
        : []
    const list = raw
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean)
    const bad = list.find((a) => !isAddress(a))
    if (bad) return { problem: `${bad} is not an email address.` }
    if (list.length > 50) return { problem: "At most 50 reply-to addresses." }
    patch.replyTo = list.length > 0 ? list : null
  }
  if (body.preview_text !== undefined) {
    patch.previewText = asNullableString(body.preview_text)?.trim() || null
  }
  if (body.variables !== undefined) {
    if (!Array.isArray(body.variables)) return { problem: "`variables` is a list." }
    if (body.variables.length > MAX_DECLARED) {
      return { problem: `A template takes at most ${MAX_DECLARED} variables.` }
    }
    const out: DeclaredVariable[] = []
    for (const v of body.variables) {
      if (!isRecord(v) || typeof v.name !== "string") {
        return { problem: "Each variable has a name." }
      }
      const name = v.name.trim()
      if (!VARIABLE_NAME.test(name)) {
        return {
          problem: `\`${name}\` is not a variable name: letters, digits and underscores, not starting with a digit.`,
        }
      }
      if (out.some((o) => o.name === name)) {
        return { problem: `\`${name}\` is declared twice.` }
      }
      const type = v.type === "number" ? "number" : "string"
      const fallback =
        typeof v.fallback === "string" && v.fallback !== ""
          ? v.fallback
          : typeof v.fallback === "number" && Number.isFinite(v.fallback)
            ? String(v.fallback)
            : null
      if (
        type === "number" &&
        fallback !== null &&
        !Number.isFinite(Number(fallback))
      ) {
        return { problem: `The fallback for \`${name}\` is not a number.` }
      }
      out.push({ name, type, fallback })
    }
    patch.variables = out
  }
  if (body.html !== undefined) patch.html = asNullableString(body.html)
  if (body.text !== undefined) patch.text = asNullableString(body.text)
  if (body.design !== undefined)
    patch.design = isRecord(body.design) ? body.design : null
  return patch
}
