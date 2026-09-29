import { createHash } from "node:crypto"
import { and, count, desc, eq, sql } from "drizzle-orm"
import {
  buildProps,
  canonicalFileSet,
  displaySkeleton,
  fill,
  markerPattern,
  nonceFrom,
  placeholders,
  skeletonFromHtml,
  type FileSet,
  type Skeleton,
  type StoredVersion,
  type TemplateLookup,
  type Variable,
} from "@repo/templates"
import { withTenant, type Database } from "../db/client.js"
import { templateVersions, templates } from "../db/core.js"
import { LIST_CAP } from "../console/marketing/shared.js"

/**
 * Templates and their versions (#160, #161).
 *
 * ⚠ A TEMPLATE IS AN IDENTITY AND A DRAFT; A SEND USES A VERSION. Versions are
 * written once and never updated, and `live_version_id` is the one pointer
 * that moves. See the table comments in db/core.ts.
 *
 * ⚠ NOTHING HERE RENDERS A TEMPLATE. An `html` version's skeleton is found by
 * pattern; a `tsx` version's arrives already rendered by the sandbox, through
 * `createRenderedVersion`. The send path reads skeletons through `lookup`.
 */

export type TemplateKind = "html" | "tsx"
/** Where a template is maintained. See `templateSource` in db/core.ts. */
export type TemplateSource = "managed" | "upload" | "github"

export interface TemplateSummary {
  id: string
  name: string
  folder: string | null
  kind: TemplateKind
  source: TemplateSource
  subject: string | null
  /** The live version's number, or 0 before the first publish. */
  version: number
  /** When the live version was created. Null before the first publish. */
  published_at: string | null
  versions: number
  created_at: string
  updated_at: string
}

export interface TemplateRow extends TemplateSummary {
  html: string | null
  text: string | null
}

export interface VersionSummary {
  id: string
  number: number
  kind: TemplateKind
  subject: string | null
  variables: Variable[]
  runtime: string | null
  /** The entry's path in the upload or repository, when there was one. */
  path: string | null
  /** The commit a GitHub template's version came from. */
  commit_sha: string | null
  live: boolean
  created_at: string
}

export interface VersionDetail extends VersionSummary {
  /** The entry `.tsx`, for `tsx` versions. */
  source: string | null
  /** The other files the entry imports, path to text. */
  files: Record<string, string> | null
  /**
   * The skeleton with its markers written as `{{ path }}`: what a person
   * reads, and what two versions are diffed by. Never what is sent.
   */
  display: { html: string | null; text: string | null }
}

/** What an upload or a push needs to know about a template before it acts. */
export interface TemplateIdentity {
  id: string
  name: string
  source: TemplateSource
  kind: TemplateKind
  /** The live version's number, or 0 before the first. */
  live_number: number
  /** The live version's hash of its files, if it is a rendered version. */
  live_sha256: string | null
}

/** A rendered template, as the sandbox returned it, to store as a version. */
export interface RenderedInput {
  /** The entry's path; absent for the single-file form. */
  entry?: string
  /** The entry's text. */
  source: string
  /** The entry and everything it imports, when the template has several files. */
  files?: FileSet
  skeleton: Skeleton
  runtime: string
  /** The template's exported subject; when present it replaces the draft's. */
  subject?: string | null
  commitSha?: string
  /** What the template becomes: an upload unless a repository made it. */
  origin?: "upload" | "github"
}

export interface Preview {
  subject: string | null
  html: string | null
  text: string | null
}

/** A version could not be made; each problem is a sentence for the author. */
export interface Problems {
  problems: string[]
}

export interface TemplateStore {
  list(tenantId: string): Promise<TemplateSummary[]>
  get(
    tenantId: string,
    id: string,
  ): Promise<(TemplateRow & { history: VersionSummary[] }) | null>
  create(
    tenantId: string,
    input: {
      name: string
      folder?: string | null
      kind?: TemplateKind
      source?: TemplateSource
    },
  ): Promise<TemplateRow | { conflict: true }>
  /** By id or by name, as a send names it. */
  identity(tenantId: string, ref: string): Promise<TemplateIdentity | null>
  update(
    tenantId: string,
    id: string,
    patch: {
      name?: string
      folder?: string | null
      subject?: string | null
      html?: string | null
      text?: string | null
    },
  ): Promise<TemplateRow | { conflict: true } | null>
  /**
   * Makes the draft a new live version. For `html`, the draft body; for `tsx`,
   * the latest version's rendering with the draft subject, so a subject edit
   * needs no re-upload and no sandbox.
   */
  publish(tenantId: string, id: string): Promise<TemplateRow | Problems | null>
  /**
   * Stores a version the sandbox rendered, and makes it live - unless its
   * files are exactly the live version's, in which case nothing is written
   * and the live version comes back marked `unchanged`.
   */
  createRenderedVersion(
    tenantId: string,
    id: string,
    input: RenderedInput,
  ): Promise<(VersionDetail & { unchanged: boolean }) | null>
  version(tenantId: string, id: string, number: number): Promise<VersionDetail | null>
  promote(tenantId: string, id: string, number: number): Promise<TemplateRow | null>
  /** A version filled with its sample values, overlaid with the caller's. */
  preview(
    tenantId: string,
    id: string,
    number: number,
    variables?: Record<string, unknown>,
  ): Promise<Preview | null>
  delete(tenantId: string, id: string): Promise<boolean>
  /** What the send path reads. See `resolveTemplateSend` in @repo/templates. */
  lookup(tenantId: string): TemplateLookup
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0]

export function templateStore(db: Database): TemplateStore {
  /** The template, its live version's number and date, and its version count. */
  const rowOf = async (tx: Tx, id: string): Promise<TemplateRow | null> => {
    const [row] = await tx.select().from(templates).where(eq(templates.id, id)).limit(1)
    if (!row) return null
    const [live] = row.liveVersionId
      ? await tx
          .select({
            number: templateVersions.number,
            createdAt: templateVersions.createdAt,
          })
          .from(templateVersions)
          .where(eq(templateVersions.id, row.liveVersionId))
      : []
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(templateVersions)
      .where(eq(templateVersions.templateId, id))
    return {
      id: row.id,
      name: row.name,
      folder: row.folder,
      kind: row.kind,
      source: row.source,
      subject: row.subject,
      html: row.html,
      text: row.text,
      version: live?.number ?? 0,
      published_at: live?.createdAt.toISOString() ?? null,
      versions: n,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    }
  }

  /**
   * Writes the next version and points `live_version_id` at it.
   *
   * ⚠ THE TEMPLATE ROW IS LOCKED FIRST, so two publishes at once number
   * themselves 4 and 5 rather than both trying 4 and one failing on the unique
   * index with an error nobody could act on.
   */
  const insertVersion = async (
    tx: Tx,
    tenantId: string,
    templateId: string,
    kind: TemplateKind,
    version: {
      subject: string | null
      skeleton: Skeleton
      html: string | null
      text: string | null
      source?: string
      runtime?: string
      files?: Record<string, string> | null
      path?: string | null
      commitSha?: string | null
      sourceSha256?: string | null
    },
  ) => {
    await tx.execute(
      sql`select 1 from ${templates} where ${templates.id} = ${templateId} for update`,
    )
    const [{ max } = { max: 0 }] = await tx
      .select({ max: sql<number>`coalesce(max(${templateVersions.number}), 0)::int` })
      .from(templateVersions)
      .where(eq(templateVersions.templateId, templateId))

    const [row] = await tx
      .insert(templateVersions)
      .values({
        tenantId,
        templateId,
        number: max + 1,
        kind,
        subject: version.subject,
        html: version.html,
        text: version.text,
        nonce: version.skeleton.nonce,
        variables: withSubjectVariables(version.skeleton.variables, version.subject),
        source: version.source ?? null,
        files: version.files ?? null,
        path: version.path ?? null,
        commitSha: version.commitSha ?? null,
        sourceSha256: version.sourceSha256 ?? null,
        runtime: version.runtime ?? null,
      })
      .returning()

    await tx
      .update(templates)
      .set({ liveVersionId: row!.id, updatedAt: new Date() })
      .where(eq(templates.id, templateId))
    return row!
  }

  return {
    async list(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        // ⚠ NO BODIES, AND A CEILING - see `listBroadcasts`.
        const rows = await tx
          .select({
            id: templates.id,
            name: templates.name,
            folder: templates.folder,
            kind: templates.kind,
            source: templates.source,
            subject: templates.subject,
            liveNumber: templateVersions.number,
            liveAt: templateVersions.createdAt,
            versions: sql<number>`(select count(*)::int from ${templateVersions} v where v.template_id = ${templates.id})`,
            createdAt: templates.createdAt,
            updatedAt: templates.updatedAt,
          })
          .from(templates)
          .leftJoin(templateVersions, eq(templateVersions.id, templates.liveVersionId))
          .orderBy(templates.folder, templates.name)
          .limit(LIST_CAP)

        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          folder: r.folder,
          kind: r.kind,
          source: r.source,
          subject: r.subject,
          version: r.liveNumber ?? 0,
          published_at: r.liveAt?.toISOString() ?? null,
          versions: r.versions,
          created_at: r.createdAt.toISOString(),
          updated_at: r.updatedAt.toISOString(),
        }))
      })
    },

    async get(tenantId, id) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        const row = await rowOf(tx, id)
        if (!row) return null
        const [template] = await tx
          .select({ live: templates.liveVersionId })
          .from(templates)
          .where(eq(templates.id, id))
        const history = await tx
          .select()
          .from(templateVersions)
          .where(eq(templateVersions.templateId, id))
          .orderBy(desc(templateVersions.number))
          .limit(LIST_CAP)
        return {
          ...row,
          history: history.map((v) => toSummary(v, template?.live ?? null)),
        }
      })
    },

    async create(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(templates)
          .values({
            tenantId,
            name: input.name.trim(),
            folder: input.folder ?? null,
            kind: input.kind ?? "html",
            source: input.source ?? (input.kind === "tsx" ? "upload" : "managed"),
          })
          .onConflictDoNothing({ target: [templates.tenantId, templates.name] })
          .returning({ id: templates.id })
        return row ? (await rowOf(tx, row.id))! : { conflict: true as const }
      })
    },

    async identity(tenantId, ref) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({
            id: templates.id,
            name: templates.name,
            source: templates.source,
            kind: templates.kind,
            liveNumber: templateVersions.number,
            liveSha256: templateVersions.sourceSha256,
          })
          .from(templates)
          .leftJoin(templateVersions, eq(templateVersions.id, templates.liveVersionId))
          .where(UUID.test(ref) ? eq(templates.id, ref) : eq(templates.name, ref))
          .limit(1)
        return row
          ? {
              id: row.id,
              name: row.name,
              source: row.source,
              kind: row.kind,
              live_number: row.liveNumber ?? 0,
              live_sha256: row.liveSha256,
            }
          : null
      })
    },

    async update(tenantId, id, patch) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        const set: Record<string, unknown> = { updatedAt: new Date() }
        if (patch.name !== undefined) set.name = patch.name.trim()
        if (patch.folder !== undefined) set.folder = patch.folder
        if (patch.subject !== undefined) set.subject = patch.subject
        if (patch.html !== undefined) set.html = patch.html
        if (patch.text !== undefined) set.text = patch.text

        try {
          const [row] = await tx
            .update(templates)
            .set(set)
            .where(eq(templates.id, id))
            .returning({ id: templates.id })
          return row ? rowOf(tx, row.id) : null
        } catch (error) {
          if (isUniqueViolation(error)) return { conflict: true as const }
          throw error
        }
      })
    },

    async publish(tenantId, id) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        const [draft] = await tx
          .select()
          .from(templates)
          .where(eq(templates.id, id))
          .limit(1)
        if (!draft) return null

        if (draft.kind === "html") {
          if (!draft.html && !draft.text) {
            return { problems: ["Write the email before publishing it."] }
          }
          const made = skeletonFromHtml({
            html: draft.html,
            text: draft.text,
            nonce: newNonce(),
          })
          if (!made.ok) return { problems: made.problems }
          await insertVersion(tx, tenantId, id, "html", {
            subject: draft.subject,
            skeleton: made.skeleton,
            html: draft.html === null ? null : made.skeleton.html,
            text: draft.text === null ? null : made.skeleton.text,
          })
          return rowOf(tx, id)
        }

        // tsx: the latest rendering, with the draft's subject.
        const [latest] = await tx
          .select()
          .from(templateVersions)
          .where(eq(templateVersions.templateId, id))
          .orderBy(desc(templateVersions.number))
          .limit(1)
        if (!latest) return { problems: ["Upload the template's .tsx file first."] }
        await insertVersion(tx, tenantId, id, "tsx", {
          subject: draft.subject,
          skeleton: {
            html: latest.html ?? "",
            text: latest.text ?? "",
            nonce: latest.nonce,
            variables: markerVariables(latest),
          },
          html: latest.html,
          text: latest.text,
          source: latest.source ?? undefined,
          runtime: latest.runtime ?? undefined,
          files: latest.files,
          path: latest.path,
          commitSha: latest.commitSha,
          sourceSha256: latest.sourceSha256,
        })
        return rowOf(tx, id)
      })
    },

    async createRenderedVersion(tenantId, id, input) {
      if (!UUID.test(id)) return null
      const entry = input.entry ?? "template.tsx"
      const files = input.files ?? { [entry]: input.source }
      const sha256 = fileSetHash(entry, files)
      return withTenant(db, tenantId, async (tx) => {
        const [draft] = await tx
          .select({
            subject: templates.subject,
            kind: templates.kind,
            source: templates.source,
            live: templates.liveVersionId,
          })
          .from(templates)
          .where(eq(templates.id, id))
          .limit(1)
          .for("update")
        if (!draft) return null

        // ⚠ THE SAME FILES AS WHAT IS LIVE MAKE NO VERSION. A re-upload of an
        // unchanged folder, or a push that touched other templates, would
        // otherwise add a version per template per push, each identical to
        // the last, and bury the history that matters.
        if (draft.live) {
          const [live] = await tx
            .select()
            .from(templateVersions)
            .where(eq(templateVersions.id, draft.live))
          if (live && live.kind === "tsx" && live.sourceSha256 === sha256) {
            return { ...toDetail(live, live.id), unchanged: true }
          }
        }

        // ⚠ AN UPLOAD MAKES THE TEMPLATE A TSX TEMPLATE. The html draft stays
        // where it was, unused, so switching back is a decision and not a loss.
        // A subject the file exports becomes the draft's too, so a later
        // subject-only publish starts from what the file said.
        const origin = input.origin ?? "upload"
        const subject = input.subject ?? draft.subject
        if (
          draft.kind !== "tsx" ||
          draft.source !== origin ||
          subject !== draft.subject
        ) {
          await tx
            .update(templates)
            .set({ kind: "tsx", source: origin, subject })
            .where(eq(templates.id, id))
        }
        const others = Object.fromEntries(
          Object.entries(files).filter(([path]) => path !== entry),
        )
        const row = await insertVersion(tx, tenantId, id, "tsx", {
          subject,
          skeleton: input.skeleton,
          html: input.skeleton.html,
          text: input.skeleton.text,
          source: input.source,
          runtime: input.runtime,
          files: Object.keys(others).length > 0 ? others : null,
          path: input.entry ?? null,
          commitSha: input.commitSha ?? null,
          sourceSha256: sha256,
        })
        return { ...toDetail(row, row.id), unchanged: false }
      })
    },

    async version(tenantId, id, number) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ version: templateVersions, live: templates.liveVersionId })
          .from(templateVersions)
          .innerJoin(templates, eq(templates.id, templateVersions.templateId))
          .where(
            and(
              eq(templateVersions.templateId, id),
              eq(templateVersions.number, number),
            ),
          )
          .limit(1)
        return row ? toDetail(row.version, row.live) : null
      })
    },

    async promote(tenantId, id, number) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        // ⚠ THE VERSION IS LOOKED UP UNDER THIS TEMPLATE, never by id alone: a
        // foreign key ignores row security, so pointing `live_version_id` at a
        // version id from somewhere else would be accepted by the database.
        const [target] = await tx
          .select({ id: templateVersions.id })
          .from(templateVersions)
          .where(
            and(
              eq(templateVersions.templateId, id),
              eq(templateVersions.number, number),
            ),
          )
        if (!target) return null
        await tx
          .update(templates)
          .set({ liveVersionId: target.id, updatedAt: new Date() })
          .where(eq(templates.id, id))
        return rowOf(tx, id)
      })
    },

    async preview(tenantId, id, number, variables) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        const [v] = await tx
          .select()
          .from(templateVersions)
          .where(
            and(
              eq(templateVersions.templateId, id),
              eq(templateVersions.number, number),
            ),
          )
          .limit(1)
        if (!v) return null
        const samples = buildProps(v.variables, (variable) => variable.preview)
        const filled = fill(v, deepMerge(samples, variables ?? {}))
        // Samples fill every variable, so this only fails on a caller's value
        // that is not a string, number or boolean; show the samples instead.
        const result = filled.ok ? filled : fill(v, samples)
        return result.ok
          ? result.filled
          : { subject: v.subject, html: v.html, text: v.text }
      })
    },

    async delete(tenantId, id) {
      if (!UUID.test(id)) return false
      return withTenant(db, tenantId, async (tx) => {
        const deleted = await tx
          .delete(templates)
          .where(eq(templates.id, id))
          .returning({ id: templates.id })
        return deleted.length > 0
      })
    },

    lookup(tenantId) {
      return {
        async versionIdFor(ref) {
          return withTenant(db, tenantId, async (tx) => {
            const byId = UUID.test(ref.id)
            const [template] = await tx
              .select({ id: templates.id, live: templates.liveVersionId })
              .from(templates)
              .where(byId ? eq(templates.id, ref.id) : eq(templates.name, ref.id))
              .limit(1)
            if (!template) return null
            if (ref.version === undefined) return template.live
            const [pinned] = await tx
              .select({ id: templateVersions.id })
              .from(templateVersions)
              .where(
                and(
                  eq(templateVersions.templateId, template.id),
                  eq(templateVersions.number, ref.version),
                ),
              )
            return pinned?.id ?? null
          })
        },
        async version(versionId) {
          if (!UUID.test(versionId)) return null
          return withTenant(db, tenantId, async (tx) => {
            const [v] = await tx
              .select()
              .from(templateVersions)
              .where(eq(templateVersions.id, versionId))
              .limit(1)
            return v ? toStored(v) : null
          })
        },
      }
    },
  }
}

function toSummary(
  v: typeof templateVersions.$inferSelect,
  liveId: string | null,
): VersionSummary {
  return {
    id: v.id,
    number: v.number,
    kind: v.kind,
    subject: v.subject,
    variables: v.variables,
    runtime: v.runtime,
    path: v.path,
    commit_sha: v.commitSha,
    live: v.id === liveId,
    created_at: v.createdAt.toISOString(),
  }
}

function toDetail(
  v: typeof templateVersions.$inferSelect,
  liveId: string | null,
): VersionDetail {
  return {
    ...toSummary(v, liveId),
    source: v.source,
    files: v.files,
    display: {
      html: displaySkeleton(v.html, v.nonce, v.variables),
      text: displaySkeleton(v.text, v.nonce, v.variables),
    },
  }
}

/**
 * What says whether two versions were made from the same files. The single-
 * file form hashes as a set of one, named `template.tsx`.
 */
export function fileSetHash(entry: string, files: FileSet): string {
  return createHash("sha256").update(canonicalFileSet(entry, files)).digest("hex")
}

function toStored(v: typeof templateVersions.$inferSelect): StoredVersion {
  return {
    id: v.id,
    templateId: v.templateId,
    number: v.number,
    subject: v.subject,
    html: v.html,
    text: v.text,
    nonce: v.nonce,
    variables: v.variables,
  }
}

/**
 * The version's variables: the markers' in index order, then any the subject
 * uses that the body does not.
 *
 * ⚠ ORDER IS LOAD-BEARING. A marker's index is its position in this list, so
 * subject-only variables are appended after the body's, never merged in.
 */
function withSubjectVariables(
  variables: readonly Variable[],
  subject: string | null,
): Variable[] {
  const out = [...variables]
  for (const path of placeholders(subject)) {
    if (!out.some((v) => v.path === path)) out.push({ path, preview: "" })
  }
  return out
}

/**
 * The body's own variables, for re-using a skeleton under a new subject.
 *
 * Markers are numbered from zero with no gaps when a version is made, so the
 * body uses exactly the first `highest index + 1` variables; the rest were the
 * old subject's, and must not stay required under a subject that dropped them.
 */
function markerVariables(v: {
  html: string | null
  text: string | null
  nonce: string
  variables: readonly Variable[]
}): Variable[] {
  let highest = -1
  for (const s of [v.html ?? "", v.text ?? ""]) {
    for (const m of s.matchAll(markerPattern(v.nonce)))
      highest = Math.max(highest, Number(m[2]))
  }
  return v.variables.slice(0, highest + 1)
}

function newNonce(): string {
  return nonceFrom(crypto.getRandomValues(new Uint8Array(12)))
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    const b = out[k]
    out[k] = isRecord(b) && isRecord(v) ? deepMerge(b, v) : v
  }
  return out
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isUniqueViolation(error: unknown): boolean {
  let e: unknown = error
  while (e && typeof e === "object") {
    if ((e as { code?: string }).code === "23505") return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}
