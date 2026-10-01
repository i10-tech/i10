import { createHash } from "node:crypto"
import { and, count, desc, eq, inArray, sql } from "drizzle-orm"
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
  withPreviewText,
} from "@repo/templates"
import { withTenant, type Database } from "../db/client.js"
import {
  githubRepositories,
  templateFolders,
  templateVersions,
  templates,
  type DeclaredVariable,
} from "../db/core.js"
import { LIST_CAP } from "../console/marketing/shared.js"
import { VersionCache } from "./version-cache.js"

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

export type TemplateKind = "html" | "tsx" | "visual"
/** Where a template is maintained. See `templateSource` in db/core.ts. */
export type TemplateSource = "managed" | "upload" | "github"

export type { DeclaredVariable }

/** A folder of templates, as Resend has them. See `templateFolders`. */
export interface TemplateFolder {
  id: string
  name: string
  /** How many templates are filed in it. */
  templates: number
  created_at: string
  updated_at: string
}

export interface TemplateSummary {
  id: string
  /** The alias a send may use; unique in the workspace. */
  name: string
  /** What people call it; null shows the alias. */
  title: string | null
  /** The folder it is filed in; null for the top level. */
  folder_id: string | null
  kind: TemplateKind
  source: TemplateSource
  subject: string | null
  /** The live version's number, or 0 before the first publish. */
  version: number
  /** When the live version was created. Null before the first publish. */
  published_at: string | null
  versions: number
  /**
   * Where a `github` template lives (#235): the repository, the template
   * directory in it, the entry's path under that directory, and whether the
   * last push still had the file. Null for every other template.
   */
  github: {
    repository: string
    directory: string
    path: string
    removed: boolean
  } | null
  created_at: string
  updated_at: string
}

export interface TemplateRow extends TemplateSummary {
  html: string | null
  text: string | null
  /** A `visual` template's draft, as the editor's TipTap JSON. */
  design: Record<string, unknown> | null
  /** The draft's default sender; a send's own `from` wins. */
  from: string | null
  reply_to: string[] | null
  /** The inbox preview line, written into the body at publish. */
  preview_text: string | null
  /** Variables declared in the editor, with their types and fallbacks. */
  variables: DeclaredVariable[]
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
  /** The defaults a send gets when it gives none. */
  from: string | null
  reply_to: string[] | null
  preview_text: string | null
  live: boolean
  created_at: string
}

export interface VersionDetail extends VersionSummary {
  /** The entry `.tsx`, for `tsx` versions. */
  source: string | null
  /** The other files the entry imports, path to text. */
  files: Record<string, string> | null
  /** A `visual` version's TipTap JSON: what reopening it in the editor loads. */
  design: Record<string, unknown> | null
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

/** What a draft edit may change. */
export interface TemplatePatch {
  name?: string
  title?: string | null
  folderId?: string | null
  /** Only between `html` and `visual`, and only for a template made here. */
  kind?: "html" | "visual"
  subject?: string | null
  from?: string | null
  replyTo?: string[] | null
  previewText?: string | null
  variables?: DeclaredVariable[]
  html?: string | null
  text?: string | null
  design?: Record<string, unknown> | null
}

export interface TemplateStore {
  list(tenantId: string): Promise<TemplateSummary[]>
  folders(tenantId: string): Promise<TemplateFolder[]>
  createFolder(
    tenantId: string,
    name: string,
  ): Promise<TemplateFolder | { conflict: true }>
  renameFolder(
    tenantId: string,
    id: string,
    name: string,
  ): Promise<TemplateFolder | { conflict: true } | null>
  /**
   * Deletes a folder. Its templates move to the top level; none is deleted.
   */
  deleteFolder(tenantId: string, id: string): Promise<boolean>
  /**
   * Files templates in a folder, or at the top level for null. The number
   * moved; null when the folder is not this workspace's.
   */
  move(tenantId: string, ids: string[], folderId: string | null): Promise<number | null>
  /** A copy of the template's draft and live version, named `<name>-copy`. */
  duplicate(tenantId: string, id: string): Promise<TemplateRow | null>
  /** The ids actually deleted. */
  deleteMany(tenantId: string, ids: string[]): Promise<string[]>
  get(
    tenantId: string,
    id: string,
  ): Promise<(TemplateRow & { history: VersionSummary[] }) | null>
  create(
    tenantId: string,
    input: {
      /**
       * The alias. Absent makes one from the title - `untitled-template`,
       * then `untitled-template-2` - as Resend's "New template" does.
       */
      name?: string
      title?: string | null
      /**
       * A folder by NAME, made if there is none: how an upload's or a
       * repository's directory files its templates.
       */
      folder?: string | null
      /** A folder by id, as the console files a new template. */
      folderId?: string | null
      kind?: TemplateKind
      source?: TemplateSource
      /** A `github` template's repository and entry path (#235). */
      github?: { repositoryId: string; path: string }
    },
  ): Promise<TemplateRow | { conflict: true }>
  /** By id or by name, as a send names it. */
  identity(tenantId: string, ref: string): Promise<TemplateIdentity | null>
  update(
    tenantId: string,
    id: string,
    patch: TemplatePatch,
  ): Promise<TemplateRow | { conflict: true } | { problem: string } | null>
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
  /**
   * The DRAFT as it would send now, every variable filled with its fallback
   * or, without one, left as its `{{ name }}` - what a test email sends. For
   * a `tsx` template, whose draft is its live version, that version.
   */
  draftEmail(
    tenantId: string,
    id: string,
  ): Promise<
    (Preview & { from: string | null; reply_to: string[] | null }) | Problems | null
  >
  delete(tenantId: string, id: string): Promise<boolean>
  /** What the send path reads. See `resolveTemplateSend` in @repo/templates. */
  lookup(tenantId: string): TemplateLookup
}

/**
 * How many templates a folder holds.
 *
 * ⚠ THE OUTER TABLE IS NAMED IN FULL. Drizzle writes a column of a one-table
 * select unqualified, and an unqualified `"id"` inside this subquery is the
 * TEMPLATE's id, so every folder counted zero.
 */
const FOLDER_COUNT = sql<number>`(select count(*)::int from "core"."templates" t where t.folder_id = "core"."template_folders"."id")`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0]

export function templateStore(
  db: Database,
  versions: VersionCache = new VersionCache(),
): TemplateStore {
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
    const [repo] = row.githubRepositoryId
      ? await tx
          .select({
            fullName: githubRepositories.fullName,
            directory: githubRepositories.directory,
          })
          .from(githubRepositories)
          .where(eq(githubRepositories.id, row.githubRepositoryId))
      : []
    return {
      id: row.id,
      name: row.name,
      title: row.title,
      folder_id: row.folderId,
      kind: row.kind,
      source: row.source,
      subject: row.subject,
      html: row.html,
      text: row.text,
      design: row.design,
      from: row.from,
      reply_to: row.replyTo,
      preview_text: row.previewText,
      variables: row.variables ?? [],
      version: live?.number ?? 0,
      published_at: live?.createdAt.toISOString() ?? null,
      versions: n,
      github: repo
        ? {
            repository: repo.fullName,
            directory: repo.directory,
            path: row.path ?? "",
            removed: row.removedAt !== null,
          }
        : null,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    }
  }

  /**
   * The folder's id if it is this workspace's - row security hides the rest -
   * or null.
   *
   * ⚠ LOOKED UP, NEVER TRUSTED. A foreign key ignores row security, so filing
   * a template under another workspace's folder id would be accepted by the
   * database without this.
   */
  const ownFolder = async (tx: Tx, id: string | null): Promise<string | null> => {
    if (id === null || !UUID.test(id)) return null
    const [row] = await tx
      .select({ id: templateFolders.id })
      .from(templateFolders)
      .where(eq(templateFolders.id, id))
    return row?.id ?? null
  }

  /** The folder of that name, made if there is none. Null for no name. */
  const folderNamed = async (
    tx: Tx,
    tenantId: string,
    name: string | null,
  ): Promise<string | null> => {
    const clean = name?.trim()
    if (!clean) return null
    await tx
      .insert(templateFolders)
      .values({ tenantId, name: clean })
      .onConflictDoNothing({ target: [templateFolders.tenantId, templateFolders.name] })
    const [row] = await tx
      .select({ id: templateFolders.id })
      .from(templateFolders)
      .where(eq(templateFolders.name, clean))
    return row?.id ?? null
  }

  /**
   * `base`, or `base-2`, `base-3`… - the first alias nobody in the workspace
   * has. Row security scopes the look to this workspace.
   */
  const freeName = async (tx: Tx, base: string): Promise<string> => {
    const taken = new Set(
      (
        await tx
          .select({ name: templates.name })
          .from(templates)
          .where(
            sql`${templates.name} = ${base} or ${templates.name} like ${`${base}-%`}`,
          )
      ).map((r) => r.name),
    )
    let name = base
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
    return name
  }

  const folderOf = async (tx: Tx, id: string): Promise<TemplateFolder | null> => {
    const [row] = await tx
      .select({
        id: templateFolders.id,
        name: templateFolders.name,
        createdAt: templateFolders.createdAt,
        updatedAt: templateFolders.updatedAt,
        templates: FOLDER_COUNT,
      })
      .from(templateFolders)
      .where(eq(templateFolders.id, id))
    return row ? toFolder(row) : null
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
      from?: string | null
      replyTo?: string[] | null
      previewText?: string | null
      /** Declared variables, whose fallbacks the version keeps. */
      declared?: readonly DeclaredVariable[] | null
      skeleton: Skeleton
      html: string | null
      text: string | null
      source?: string
      runtime?: string
      files?: Record<string, string> | null
      path?: string | null
      commitSha?: string | null
      sourceSha256?: string | null
      design?: Record<string, unknown> | null
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
        from: version.from ?? null,
        replyTo: version.replyTo && version.replyTo.length > 0 ? version.replyTo : null,
        previewText: version.previewText ?? null,
        html: version.html,
        text: version.text,
        nonce: version.skeleton.nonce,
        variables: withDeclared(
          withSubjectVariables(version.skeleton.variables, version.subject),
          version.declared ?? [],
        ),
        source: version.source ?? null,
        files: version.files ?? null,
        path: version.path ?? null,
        commitSha: version.commitSha ?? null,
        sourceSha256: version.sourceSha256 ?? null,
        runtime: version.runtime ?? null,
        design: version.design ?? null,
      })
      .returning()

    // ⚠ STAMPED WITH THE VERSION'S OWN TIME, NOT A FRESH CLOCK READ. "Edited
    // after it was published" is `updated_at > published_at`; a second
    // reading of the clock here was always a little later, so every template
    // read as having unpublished changes the moment it was published.
    await tx
      .update(templates)
      .set({ liveVersionId: row!.id, updatedAt: row!.createdAt })
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
            title: templates.title,
            folderId: templates.folderId,
            kind: templates.kind,
            source: templates.source,
            subject: templates.subject,
            liveNumber: templateVersions.number,
            liveAt: templateVersions.createdAt,
            versions: sql<number>`(select count(*)::int from ${templateVersions} v where v.template_id = ${templates.id})`,
            repository: githubRepositories.fullName,
            directory: githubRepositories.directory,
            path: templates.path,
            removedAt: templates.removedAt,
            createdAt: templates.createdAt,
            updatedAt: templates.updatedAt,
          })
          .from(templates)
          .leftJoin(templateVersions, eq(templateVersions.id, templates.liveVersionId))
          .leftJoin(
            githubRepositories,
            eq(githubRepositories.id, templates.githubRepositoryId),
          )
          .orderBy(templates.name)
          .limit(LIST_CAP)

        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          title: r.title,
          folder_id: r.folderId,
          kind: r.kind,
          source: r.source,
          subject: r.subject,
          version: r.liveNumber ?? 0,
          published_at: r.liveAt?.toISOString() ?? null,
          versions: r.versions,
          github: r.repository
            ? {
                repository: r.repository,
                directory: r.directory ?? "",
                path: r.path ?? "",
                removed: r.removedAt !== null,
              }
            : null,
          created_at: r.createdAt.toISOString(),
          updated_at: r.updatedAt.toISOString(),
        }))
      })
    },

    async folders(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select({
            id: templateFolders.id,
            name: templateFolders.name,
            createdAt: templateFolders.createdAt,
            updatedAt: templateFolders.updatedAt,
            templates: FOLDER_COUNT,
          })
          .from(templateFolders)
          .orderBy(templateFolders.name)
          .limit(LIST_CAP)
        return rows.map(toFolder)
      })
    },

    async createFolder(tenantId, name) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(templateFolders)
          .values({ tenantId, name: name.trim() })
          .onConflictDoNothing({
            target: [templateFolders.tenantId, templateFolders.name],
          })
          .returning({ id: templateFolders.id })
        return row ? (await folderOf(tx, row.id))! : { conflict: true as const }
      })
    },

    async renameFolder(tenantId, id, name) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        try {
          const [row] = await tx
            .update(templateFolders)
            .set({ name: name.trim(), updatedAt: new Date() })
            .where(eq(templateFolders.id, id))
            .returning({ id: templateFolders.id })
          return row ? folderOf(tx, row.id) : null
        } catch (error) {
          if (isUniqueViolation(error)) return { conflict: true as const }
          throw error
        }
      })
    },

    async deleteFolder(tenantId, id) {
      if (!UUID.test(id)) return false
      return withTenant(db, tenantId, async (tx) => {
        // Its templates move to the top level by the foreign key's SET NULL.
        const deleted = await tx
          .delete(templateFolders)
          .where(eq(templateFolders.id, id))
          .returning({ id: templateFolders.id })
        return deleted.length > 0
      })
    },

    async move(tenantId, ids, folderId) {
      const valid = ids.filter((id) => UUID.test(id))
      return withTenant(db, tenantId, async (tx) => {
        const target = await ownFolder(tx, folderId)
        if (folderId !== null && target === null) return null
        if (valid.length === 0) return 0
        const moved = await tx
          .update(templates)
          .set({ folderId: target, updatedAt: new Date() })
          .where(inArray(templates.id, valid))
          .returning({ id: templates.id })
        return moved.length
      })
    },

    async duplicate(tenantId, id) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        const [source] = await tx
          .select()
          .from(templates)
          .where(eq(templates.id, id))
          .limit(1)
        if (!source) return null

        // ⚠ THE FIRST FREE NAME, because names are unique and a send may use
        // one: `welcome-copy`, then `welcome-copy-2`.
        const name = await freeName(tx, `${source.name}-copy`)

        // ⚠ A COPY IS THIS WORKSPACE'S OWN. A GitHub template's copy is not
        // in the repository, so it becomes an upload; it keeps the files.
        const [row] = await tx
          .insert(templates)
          .values({
            tenantId,
            name,
            title: source.title ? `${source.title} (copy)` : null,
            folderId: source.folderId,
            kind: source.kind,
            source: source.source === "github" ? "upload" : source.source,
            subject: source.subject,
            from: source.from,
            replyTo: source.replyTo,
            previewText: source.previewText,
            variables: source.variables,
            html: source.html,
            text: source.text,
            design: source.design,
          })
          .returning({ id: templates.id })

        // The live version comes too, as the copy's v1, so it sends at once.
        if (source.liveVersionId) {
          const [live] = await tx
            .select()
            .from(templateVersions)
            .where(eq(templateVersions.id, source.liveVersionId))
          if (live) {
            const rest: Partial<typeof live> = { ...live }
            delete rest.id
            delete rest.createdAt
            const [copy] = await tx
              .insert(templateVersions)
              .values({ ...(rest as typeof live), templateId: row!.id, number: 1 })
              .returning({ id: templateVersions.id })
            await tx
              .update(templates)
              .set({ liveVersionId: copy!.id })
              .where(eq(templates.id, row!.id))
          }
        }
        return rowOf(tx, row!.id)
      })
    },

    async deleteMany(tenantId, ids) {
      const valid = ids.filter((id) => UUID.test(id))
      if (valid.length === 0) return []
      return withTenant(db, tenantId, async (tx) => {
        const deleted = await tx
          .delete(templates)
          .where(inArray(templates.id, valid))
          .returning({ id: templates.id })
        return deleted.map((d) => d.id)
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
        const folderId =
          input.folderId !== undefined
            ? await ownFolder(tx, input.folderId)
            : await folderNamed(tx, tenantId, input.folder ?? null)
        const name =
          input.name?.trim() ||
          (await freeName(tx, slugOf(input.title ?? "") || "untitled-template"))
        const [row] = await tx
          .insert(templates)
          .values({
            tenantId,
            name,
            title: input.title?.trim() || null,
            folderId,
            kind: input.kind ?? "html",
            source: input.source ?? (input.kind === "tsx" ? "upload" : "managed"),
            githubRepositoryId: input.github?.repositoryId ?? null,
            path: input.github?.path ?? null,
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
        if (patch.title !== undefined) set.title = patch.title?.trim() || null
        if (patch.folderId !== undefined) {
          const folderId = await ownFolder(tx, patch.folderId)
          if (patch.folderId !== null && folderId === null) {
            return { problem: "No folder with that id." }
          }
          set.folderId = folderId
        }
        if (patch.kind !== undefined) {
          // ⚠ ONLY BETWEEN THE TWO THINGS THE EDITOR WRITES. A `tsx` template
          // is made by its files; switching one to HTML would orphan them.
          const [current] = await tx
            .select({ kind: templates.kind, source: templates.source })
            .from(templates)
            .where(eq(templates.id, id))
          if (current && (current.kind === "tsx" || current.source !== "managed")) {
            return { problem: "Only a template written here can switch editors." }
          }
          set.kind = patch.kind
        }
        if (patch.from !== undefined) set.from = patch.from
        if (patch.replyTo !== undefined) set.replyTo = patch.replyTo
        if (patch.previewText !== undefined) set.previewText = patch.previewText
        if (patch.variables !== undefined) set.variables = patch.variables
        if (patch.subject !== undefined) set.subject = patch.subject
        if (patch.html !== undefined) set.html = patch.html
        if (patch.text !== undefined) set.text = patch.text
        if (patch.design !== undefined) set.design = patch.design

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

        // ⚠ A VISUAL TEMPLATE PUBLISHES EXACTLY LIKE AN HTML ONE (#243). The
        // editor exported `html` and `text` from its document; the version is
        // made from those by finding `{{ name }}`, and keeps the document so
        // it can be reopened.
        if (draft.kind === "html" || draft.kind === "visual") {
          if (!draft.html && !draft.text) {
            return { problems: ["Write the email before publishing it."] }
          }
          // ⚠ THE PREVIEW LINE IS WRITTEN INTO THE BODY HERE, before the
          // placeholders are found, so a variable in it is filled like any
          // other. The draft keeps the HTML exactly as written.
          const made = skeletonFromHtml({
            html:
              draft.html === null
                ? null
                : withPreviewText(draft.html, draft.previewText),
            text: draft.text,
            nonce: newNonce(),
          })
          if (!made.ok) return { problems: made.problems }
          await insertVersion(tx, tenantId, id, draft.kind, {
            subject: draft.subject,
            from: draft.from,
            replyTo: draft.replyTo,
            previewText: draft.previewText,
            declared: draft.variables,
            skeleton: made.skeleton,
            html: draft.html === null ? null : made.skeleton.html,
            text: draft.text === null ? null : made.skeleton.text,
            design: draft.kind === "visual" ? draft.design : null,
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
          from: draft.from,
          replyTo: draft.replyTo,
          declared: draft.variables,
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
            from: templates.from,
            replyTo: templates.replyTo,
            variables: templates.variables,
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
          from: draft.from,
          replyTo: draft.replyTo,
          declared: draft.variables,
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

    async draftEmail(tenantId, id) {
      if (!UUID.test(id)) return null
      return withTenant(db, tenantId, async (tx) => {
        const [draft] = await tx
          .select()
          .from(templates)
          .where(eq(templates.id, id))
          .limit(1)
        if (!draft) return null
        const defaults = { from: draft.from, reply_to: draft.replyTo }

        if (draft.kind === "tsx") {
          if (!draft.liveVersionId) {
            return { problems: ["Upload the template's .tsx file first."] }
          }
          const [v] = await tx
            .select()
            .from(templateVersions)
            .where(eq(templateVersions.id, draft.liveVersionId))
          if (!v) return { problems: ["Upload the template's .tsx file first."] }
          const samples = buildProps(
            v.variables,
            (x) => x.fallback ?? (x.preview || `{{ ${x.path} }}`),
          )
          const filled = fill({ ...v, subject: draft.subject ?? v.subject }, samples)
          return filled.ok
            ? { ...filled.filled, ...defaults }
            : { problems: ["The template's variables could not be filled."] }
        }

        if (!draft.html && !draft.text) {
          return { problems: ["Write the email before sending a test."] }
        }
        const made = skeletonFromHtml({
          html:
            draft.html === null ? null : withPreviewText(draft.html, draft.previewText),
          text: draft.text,
          nonce: newNonce(),
        })
        if (!made.ok) return { problems: made.problems }
        const variables = withDeclared(
          withSubjectVariables(made.skeleton.variables, draft.subject),
          draft.variables ?? [],
        )
        const samples = buildProps(variables, (x) => x.fallback ?? `{{ ${x.path} }}`)
        const filled = fill(
          {
            html: draft.html === null ? null : made.skeleton.html,
            text: draft.text === null ? null : made.skeleton.text,
            subject: draft.subject,
            nonce: made.skeleton.nonce,
            variables,
          },
          samples,
        )
        return filled.ok
          ? { ...filled.filled, ...defaults }
          : { problems: ["The template's variables could not be filled."] }
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
        /*
         * ⚠ ONE TRANSACTION PER SEND, AND ONE QUERY WHEN THE VERSION IS
         * CACHED (#238). The reference is always resolved against Postgres,
         * because live moves; the version's content is fetched in the same
         * transaction only when this process has not seen it, and then kept.
         */
        async versionIdFor(ref) {
          return withTenant(db, tenantId, async (tx) => {
            const byId = UUID.test(ref.id)
            const which = byId ? eq(templates.id, ref.id) : eq(templates.name, ref.id)
            const [row] = await tx
              .select({ id: templateVersions.id })
              .from(templates)
              .innerJoin(
                templateVersions,
                ref.version === undefined
                  ? eq(templateVersions.id, templates.liveVersionId)
                  : and(
                      eq(templateVersions.templateId, templates.id),
                      eq(templateVersions.number, ref.version),
                    ),
              )
              .where(which)
              .limit(1)
            if (!row) return null
            if (!versions.get(tenantId, row.id)) {
              const [v] = await tx
                .select()
                .from(templateVersions)
                .where(eq(templateVersions.id, row.id))
                .limit(1)
              if (v) versions.set(tenantId, toStored(v))
            }
            return row.id
          })
        },
        async version(versionId) {
          const cached = versions.get(tenantId, versionId)
          if (cached) return cached
          if (!UUID.test(versionId)) return null
          return withTenant(db, tenantId, async (tx) => {
            const [v] = await tx
              .select()
              .from(templateVersions)
              .where(eq(templateVersions.id, versionId))
              .limit(1)
            if (!v) return null
            const stored = toStored(v)
            versions.set(tenantId, stored)
            return stored
          })
        },
      }
    },
  }
}

/** `Password reset!` as `password-reset`: an alias made from a title. */
export function slugOf(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

function toFolder(row: {
  id: string
  name: string
  templates: number
  createdAt: Date
  updatedAt: Date
}): TemplateFolder {
  return {
    id: row.id,
    name: row.name,
    templates: row.templates,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
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
    from: v.from,
    reply_to: v.replyTo,
    preview_text: v.previewText,
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
    design: v.design,
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
    from: v.from,
    replyTo: v.replyTo,
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
 * The version's variables with what the editor declared about them: a
 * declared fallback is kept on the variable, so a send may leave it out, and
 * is its preview sample, so thumbnails and previews show it.
 */
function withDeclared(
  variables: readonly Variable[],
  declared: readonly DeclaredVariable[],
): Variable[] {
  return variables.map((v) => {
    const d = declared.find((x) => x.name === v.path)
    if (!d || d.fallback === null) return v
    return { ...v, preview: v.preview || d.fallback, fallback: d.fallback }
  })
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
