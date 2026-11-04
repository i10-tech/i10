import { z } from "zod"
import { normaliseEmail } from "./model.js"

/**
 * SCIM 2.0 as we speak it (#342, RFC 7643 and 7644, sso.md 2.7): resources,
 * filters, pagination, PATCH, errors and the discovery documents. Pure: the
 * routes (routes/scim.ts) do the I/O, the store (identity/scim-store.ts)
 * keeps what this returns, and the apply job (identity/directory.ts) turns it
 * into Clerk accounts.
 *
 * ⚠ THREE DIALECTS, ONE MODEL. RFC 7644 is the floor. Entra speaks its own
 * PATCH (capitalised ops, `"True"`/`"False"` strings, path-less value objects
 * whose keys are themselves paths, `members` removed by a `value` list, and
 * the `aadOptscim062020` flag on the base URL that we simply tolerate); Okta
 * replaces `active` with a path-less object, sends `id` inside values and
 * updates profiles with PUT. Every one of them is read into the same stored
 * resource, and every rule below says which dialect it is for.
 *
 * ⚠ STRICT WHERE IT DECIDES WHAT IS READ, LENIENT WHERE AN IdP WOULD WEDGE.
 * A filter is `eq` on the attributes Entra, Okta and Google send, joined by
 * `and`; anything else is `invalidFilter`. A PATCH that targets a value that
 * is not there yet makes it (Entra's dialect relies on it), and removing what
 * is already gone is a no-op (Okta retries removals).
 */

export const SCHEMA = {
  user: "urn:ietf:params:scim:schemas:core:2.0:User",
  group: "urn:ietf:params:scim:schemas:core:2.0:Group",
  enterprise: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
  list: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  patch: "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  error: "urn:ietf:params:scim:api:messages:2.0:Error",
  serviceProviderConfig: "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig",
  resourceType: "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
  schema: "urn:ietf:params:scim:schemas:core:2.0:Schema",
} as const

export const SCIM_CONTENT_TYPE = "application/scim+json"

/** Every bound the protocol layer holds a request to. */
export const LIMITS = {
  /** A request body, in bytes. */
  body: 1024 * 1024,
  /** A stored resource, as JSON characters. */
  resource: 64 * 1024,
  /** Any one string value. */
  string: 2048,
  /** userName, displayName, externalId. */
  name: 256,
  /** PATCH operations in one request. */
  operations: 1000,
  /** Entries of one multi-valued attribute (emails, phoneNumbers...). */
  multi: 50,
  /** Members named in one request. */
  members: 10_000,
  /** A filter or a PATCH path. */
  filter: 1024,
  /** JSON nesting. */
  depth: 8,
  /** Page size. */
  maxCount: 500,
  defaultCount: 100,
} as const

export type ScimType =
  | "invalidFilter"
  | "tooMany"
  | "uniqueness"
  | "mutability"
  | "invalidSyntax"
  | "invalidPath"
  | "noTarget"
  | "invalidValue"
  | "invalidVers"
  | "sensitive"

/** A refusal in SCIM's own error shape (RFC 7644 3.12). */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: ScimType,
  ) {
    super(detail)
    this.name = "ScimError"
  }
}

export function errorBody(error: ScimError) {
  return {
    schemas: [SCHEMA.error],
    status: String(error.status),
    ...(error.scimType ? { scimType: error.scimType } : {}),
    detail: error.detail,
  }
}

const bad = (detail: string, scimType: ScimType = "invalidValue") =>
  new ScimError(400, detail, scimType)

// ── JSON hygiene ────────────────────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Doc = Record<string, Json>

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A request value as plain JSON within our bounds, or a refusal.
 *
 * ⚠ CHECKED BEFORE ANYTHING READS IT. Depth, string length and array length
 * are bounded here once, so nothing downstream can be walked into a deep or
 * enormous structure, and `__proto__` never becomes a key we copy.
 */
export function boundedJson(value: unknown, depth = 0): Json {
  if (depth > LIMITS.depth) throw bad("The request nests too deeply.", "invalidSyntax")
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw bad("Numbers must be finite.")
    return value
  }
  if (typeof value === "string") {
    if (value.length > LIMITS.string) throw bad("A value is too long.")
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > LIMITS.members) throw bad("Too many values.", "tooMany")
    return value.map((v) => boundedJson(v, depth + 1))
  }
  if (isObject(value)) {
    const out: Doc = {}
    for (const [key, v] of Object.entries(value)) {
      if (key.length > 512) throw bad("An attribute name is too long.", "invalidSyntax")
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue
      out[key] = boundedJson(v, depth + 1)
    }
    return out
  }
  throw bad("The request is not JSON.", "invalidSyntax")
}

// ── Attribute names ─────────────────────────────────────────────────────────

const USER_ATTRIBUTES = [
  "userName",
  "externalId",
  "name",
  "displayName",
  "nickName",
  "profileUrl",
  "title",
  "userType",
  "preferredLanguage",
  "locale",
  "timezone",
  "active",
  "emails",
  "phoneNumbers",
  "ims",
  "photos",
  "addresses",
  "entitlements",
  "roles",
  "x509Certificates",
] as const

const GROUP_ATTRIBUTES = ["displayName", "externalId", "members"] as const

const NAME_PARTS = [
  "formatted",
  "familyName",
  "givenName",
  "middleName",
  "honorificPrefix",
  "honorificSuffix",
] as const

const ENTERPRISE_ATTRIBUTES = [
  "employeeNumber",
  "costCenter",
  "organization",
  "division",
  "department",
  "manager",
] as const

const MULTI_VALUED = new Set(
  [
    "emails",
    "phoneNumbers",
    "ims",
    "photos",
    "addresses",
    "entitlements",
    "roles",
    "x509Certificates",
    "members",
  ].map((a) => a.toLowerCase()),
)

const VALUE_PARTS = ["value", "display", "type", "primary", "$ref"] as const

/** The canonical spelling of a name (SCIM names are case-insensitive), or the name. */
function canonical(name: string, known: readonly string[]): string {
  const lower = name.toLowerCase()
  return known.find((k) => k.toLowerCase() === lower) ?? name
}

/** The key an object already holds for this name, whatever its case. */
function keyIn(container: Doc, name: string, known: readonly string[]): string {
  const lower = name.toLowerCase()
  return (
    Object.keys(container).find((k) => k.toLowerCase() === lower) ??
    canonical(name, known)
  )
}

const knownFor = (urn: string | null, kind: Kind): readonly string[] =>
  urn === SCHEMA.enterprise
    ? ENTERPRISE_ATTRIBUTES
    : kind === "User"
      ? USER_ATTRIBUTES
      : GROUP_ATTRIBUTES

const KNOWN_URNS = [SCHEMA.user, SCHEMA.group, SCHEMA.enterprise] as const

/** A schema URN in our spelling: the three we know, else as sent. */
function canonicalUrn(urn: string): string {
  return KNOWN_URNS.find((u) => u.toLowerCase() === urn.toLowerCase()) ?? urn
}

export type Kind = "User" | "Group"

// ── Filters (RFC 7644 3.4.2.2), strictly ────────────────────────────────────

export type UserFilterTerm = {
  attr: "userName" | "externalId" | "emails.value" | "workEmail"
  value: string
}
export type GroupFilterTerm = {
  attr: "displayName" | "externalId"
  value: string
}
export type UserFilter = { terms: readonly UserFilterTerm[] }
export type GroupFilter = { terms: readonly GroupFilterTerm[] }

/**
 * One `eq` term and the `and` after it, if any. The path may be namespaced by
 * a schema URN and may be Entra's bracketed work-email form.
 */
const FILTER_TERM =
  /^\s*((?:[\w.-]+:)*[\w.-]+(?:\[\s*[\w.-]+\s+eq\s+"(?:[^"\\]|\\.)*"\s*\])?(?:\.[\w.-]+)?)\s+([A-Za-z]+)\s+("(?:[^"\\]|\\.)*")\s*(?:(and)\s+|$)/i

/**
 * `filter=` as one of the comparisons we answer, or `invalidFilter`.
 *
 * ⚠ ONLY `eq`, ONLY THESE ATTRIBUTES, AND `and` BETWEEN TERMS. That is what
 * Entra and Okta send to find a resource before creating it, and nothing else
 * is answered: `or`, `pr`, `co`, another attribute or a malformed value is
 * refused, never read as "no filter" (which would list everybody and lead an
 * IdP to match the wrong person).
 */
export function parseFilter(raw: string | undefined, kind: "User"): UserFilter | null
export function parseFilter(raw: string | undefined, kind: "Group"): GroupFilter | null
export function parseFilter(
  raw: string | undefined,
  kind: Kind,
): UserFilter | GroupFilter | null {
  if (raw === undefined) return null
  if (raw.length > LIMITS.filter) throw bad("The filter is too long.", "invalidFilter")
  const terms: (UserFilterTerm | GroupFilterTerm)[] = []
  let rest = raw
  for (;;) {
    const match = FILTER_TERM.exec(rest)
    if (!match)
      throw bad(
        'Only supported eq filters joined by "and" are allowed.',
        "invalidFilter",
      )
    const [, path, op, literal, and] = match
    if (op!.toLowerCase() !== "eq")
      throw bad(`The ${op} operator is not supported; use eq.`, "invalidFilter")
    let value: unknown
    try {
      value = JSON.parse(literal!)
    } catch {
      throw bad("The filter's value is not a valid string.", "invalidFilter")
    }
    if (typeof value !== "string" || value.length > LIMITS.string)
      throw bad("The filter's value is not a valid string.", "invalidFilter")
    const core = kind === "User" ? SCHEMA.user : SCHEMA.group
    const prefixed = path!.toLowerCase().startsWith(`${core.toLowerCase()}:`)
    const attr = prefixed ? path!.slice(core.length + 1) : path!
    if (kind === "User") {
      const parsed = userFilterAttr(attr)
      if (parsed) terms.push({ attr: parsed, value })
      else throw bad(`Filtering on ${path} is not supported.`, "invalidFilter")
    } else {
      const parsed = groupFilterAttr(attr)
      if (parsed) terms.push({ attr: parsed, value })
      else throw bad(`Filtering on ${path} is not supported.`, "invalidFilter")
    }
    rest = rest.slice(match[0].length)
    if (!and) break
  }
  return kind === "User"
    ? { terms: terms as UserFilterTerm[] }
    : { terms: terms as GroupFilterTerm[] }
}

/** The User paths this endpoint answers, including Entra's work-email form. */
function userFilterAttr(path: string): UserFilterTerm["attr"] | null {
  const lower = path.toLowerCase()
  if (lower === "username") return "userName"
  if (lower === "externalid") return "externalId"
  if (lower === "emails.value") return "emails.value"
  if (/^emails\[\s*type\s+eq\s+"work"\s*\]\.value$/i.test(path)) return "workEmail"
  return null
}

function groupFilterAttr(path: string): GroupFilterTerm["attr"] | null {
  const lower = path.toLowerCase()
  if (lower === "displayname") return "displayName"
  if (lower === "externalid") return "externalId"
  return null
}

// ── Pagination and projection ───────────────────────────────────────────────

const intParam = z
  .string()
  .max(12)
  .regex(/^-?\d+$/)
  .transform(Number)

const listQuery = z.object({
  startIndex: intParam.optional(),
  count: intParam.optional(),
  filter: z.string().max(LIMITS.filter).optional(),
  attributes: z.string().max(LIMITS.filter).optional(),
  excludedAttributes: z.string().max(LIMITS.filter).optional(),
})

export interface ListQuery {
  /** 1-based. */
  startIndex: number
  count: number
  filter: string | undefined
  attributes: string[]
  excluded: string[]
}

/**
 * `startIndex`, `count`, `filter`, `attributes`, `excludedAttributes`.
 *
 * ⚠ RFC 7644 3.4.2.4: a `startIndex` under 1 is 1 and a negative `count` is
 * 0; a value that is not a number at all is refused. `count` is capped at
 * `LIMITS.maxCount`, which ServiceProviderConfig advertises.
 */
export function readListQuery(query: Record<string, string | undefined>): ListQuery {
  const parsed = listQuery.safeParse(query)
  if (!parsed.success) throw bad("startIndex and count must be integers.")
  const q = parsed.data
  return {
    startIndex: Math.max(1, q.startIndex ?? 1),
    count: Math.min(Math.max(0, q.count ?? LIMITS.defaultCount), LIMITS.maxCount),
    filter: q.filter,
    attributes: names(q.attributes),
    excluded: names(q.excludedAttributes),
  }
}

/** Projection-only reads of one resource: `attributes` and `excludedAttributes`. */
export function readProjection(query: Record<string, string | undefined>) {
  const read = readListQuery({
    attributes: query.attributes,
    excludedAttributes: query.excludedAttributes,
  })
  return { attributes: read.attributes, excluded: read.excluded }
}

function names(raw: string | undefined): string[] {
  if (!raw) return []
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (list.length > 50) throw bad("Too many attributes named.", "tooMany")
  return list
}

const ALWAYS = new Set(["id", "schemas", "meta"])

/**
 * The resource with only the asked-for top-level attributes, or without the
 * excluded ones (Entra asks for groups with `excludedAttributes=members`).
 * `id`, `schemas` and `meta` are always returned.
 */
export function project(
  resource: Record<string, unknown>,
  q: { attributes: string[]; excluded: string[] },
): Record<string, unknown> {
  const top = (name: string) => {
    const lower = name.toLowerCase()
    // ⚠ THE EXTENSION IS ONE KEY, NAMED BY ITS URN, AND A URN HAS DOTS IN IT.
    const extension = SCHEMA.enterprise.toLowerCase()
    if (lower === extension || lower.startsWith(`${extension}:`)) return extension
    const urn = [SCHEMA.user, SCHEMA.group].find((u) =>
      lower.startsWith(`${u.toLowerCase()}:`),
    )
    const rest = urn ? lower.slice(urn.length + 1) : lower
    return rest.split(".")[0]!
  }
  if (q.attributes.length > 0) {
    const keep = new Set(q.attributes.map(top))
    return Object.fromEntries(
      Object.entries(resource).filter(
        ([k]) => ALWAYS.has(k) || keep.has(k.toLowerCase()),
      ),
    )
  }
  if (q.excluded.length > 0) {
    const drop = new Set(q.excluded.map(top))
    return Object.fromEntries(
      Object.entries(resource).filter(
        ([k]) => ALWAYS.has(k) || !drop.has(k.toLowerCase()),
      ),
    )
  }
  return resource
}

export function listResponse(
  resources: Record<string, unknown>[],
  total: number,
  startIndex: number,
) {
  return {
    schemas: [SCHEMA.list],
    totalResults: total,
    itemsPerPage: resources.length,
    startIndex,
    Resources: resources,
  }
}

// ── Reading resources ───────────────────────────────────────────────────────

/** `"True"`/`"False"` (Entra) as booleans; anything else as it is. */
function bool(value: Json | undefined): Json | undefined {
  if (typeof value !== "string") return value
  const lower = value.toLowerCase()
  return lower === "true" ? true : lower === "false" ? false : value
}

const text = (max: number) => z.string().trim().max(max)

const multiEntry = z.looseObject({
  value: z.union([z.string().max(LIMITS.string), z.number(), z.boolean()]).optional(),
  display: text(LIMITS.name).optional(),
  type: text(64).optional(),
  primary: z.boolean().optional(),
})

/**
 * The stored User resource's rules, checked after every write and PATCH.
 *
 * ⚠ `userName` IS REQUIRED AND UNIQUE (case-insensitively) WITHIN A DIRECTORY,
 * as RFC 7643 4.1.1 says; everything else is optional, and attributes we do
 * not know are kept (custom attributes, as the IdP sent them).
 */
const storedUser = z.looseObject({
  userName: text(LIMITS.name).min(1, "userName is required."),
  externalId: text(LIMITS.name).nullable().optional(),
  displayName: text(LIMITS.name).nullable().optional(),
  active: z.boolean({ error: "active must be true or false." }),
  name: z
    .looseObject(
      Object.fromEntries(
        NAME_PARTS.map((p) => [p, text(LIMITS.name).nullable().optional()]),
      ),
    )
    .nullable()
    .optional(),
  emails: z
    .array(
      multiEntry.extend({
        value: z.string().trim().max(320),
      }),
    )
    .max(LIMITS.multi)
    .optional(),
  phoneNumbers: z.array(multiEntry).max(LIMITS.multi).optional(),
  [SCHEMA.enterprise]: z
    .looseObject({
      employeeNumber: text(LIMITS.name).nullable().optional(),
      department: text(LIMITS.name).nullable().optional(),
      manager: z
        .looseObject({
          value: text(LIMITS.name).nullable().optional(),
          displayName: text(LIMITS.name).nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
})

const storedGroup = z.looseObject({
  displayName: text(LIMITS.name).min(1, "displayName is required."),
  externalId: text(LIMITS.name).nullable().optional(),
  members: z
    .array(
      z.looseObject({
        value: z.string().trim().min(1).max(LIMITS.name),
        display: text(LIMITS.name).optional(),
      }),
    )
    .max(LIMITS.members)
    .optional(),
})

/** What the store keeps for a user: the resource and the columns read from it. */
export interface StoredUser {
  userName: string
  externalId: string | null
  displayName: string | null
  givenName: string | null
  familyName: string | null
  email: string | null
  active: boolean
  resource: Record<string, unknown>
}

export interface StoredGroup {
  displayName: string
  externalId: string | null
  /** Member ids as sent, deduplicated, in order. */
  members: string[]
  resource: Record<string, unknown>
}

/**
 * A request body (POST, PUT) as a stored resource: readOnly attributes and
 * passwords dropped, names put in their canonical case, extensions under their
 * URN. Shared by PATCH, which edits a stored resource and reads it back here.
 */
function toDoc(body: unknown, kind: Kind): Doc {
  const json = boundedJson(body)
  if (!isObject(json)) throw bad("The resource must be a JSON object.", "invalidSyntax")
  const core = kind === "User" ? SCHEMA.user : SCHEMA.group
  const doc: Doc = {}
  for (const [key, value] of Object.entries(json)) {
    const lower = key.toLowerCase()
    if (["id", "meta", "schemas", "groups", "password"].includes(lower)) continue
    if (lower === core.toLowerCase()) {
      // The core schema's attributes, namespaced: read as top-level ones.
      if (isObject(value))
        for (const [k, v] of Object.entries(value))
          doc[canonical(k, knownFor(null, kind))] = v as Json
      continue
    }
    if (lower.startsWith("urn:")) {
      if (kind === "Group" || !isObject(value)) continue
      const urn = canonicalUrn(key)
      const known = knownFor(urn, kind)
      const ext: Doc = {}
      for (const [k, v] of Object.entries(value)) ext[canonical(k, known)] = v as Json
      doc[urn] = ext
      continue
    }
    doc[canonical(key, knownFor(null, kind))] = value as Json
  }
  return doc
}

/** Coerces Entra's string booleans where a boolean belongs. */
function coerce(doc: Doc): Doc {
  if ("active" in doc) doc.active = bool(doc.active) as Json
  for (const [key, value] of Object.entries(doc))
    if (MULTI_VALUED.has(key.toLowerCase()) && Array.isArray(value))
      doc[key] = value.map((entry) =>
        isObject(entry) && "primary" in entry
          ? { ...entry, primary: bool(entry.primary as Json) as Json }
          : entry,
      )
  return doc
}

const issue = (error: z.ZodError) =>
  error.issues[0]?.message ?? "The resource is not valid."

/** The resource a User request or PATCH leaves, checked and read into columns. */
export function readUser(body: unknown): StoredUser {
  const doc = coerce(toDoc(body, "User"))
  if (doc.active === undefined) doc.active = true
  return finishUser(doc)
}

function finishUser(doc: Doc): StoredUser {
  const parsed = storedUser.safeParse(doc)
  if (!parsed.success) throw bad(issue(parsed.error))
  const user = parsed.data
  const size = JSON.stringify(doc).length
  if (size > LIMITS.resource) throw bad("The resource is too large.", "tooMany")
  const name = user.name ?? null
  return {
    userName: user.userName,
    externalId: user.externalId || null,
    displayName: user.displayName || null,
    givenName: (name?.givenName as string | null | undefined) || null,
    familyName: (name?.familyName as string | null | undefined) || null,
    email: primaryEmail(user.emails ?? [], user.userName),
    active: user.active,
    resource: doc,
  }
}

/**
 * The address we act on: the one marked primary, else the work one, else the
 * first; with none at all, the userName when it is itself an address (Okta's
 * default). Normalised, or null.
 */
export function primaryEmail(
  emails: readonly {
    value: string
    type?: string | undefined
    primary?: boolean | undefined
  }[],
  userName: string,
): string | null {
  const pick =
    emails.find((e) => e.primary === true) ??
    emails.find((e) => e.type?.toLowerCase() === "work") ??
    emails[0]
  return normaliseEmail(pick ? pick.value : userName)
}

/** The resource a Group request or PATCH leaves. */
export function readGroup(body: unknown): StoredGroup {
  return finishGroup(toDoc(body, "Group"))
}

function finishGroup(doc: Doc): StoredGroup {
  const parsed = storedGroup.safeParse(doc)
  if (!parsed.success) throw bad(issue(parsed.error))
  const group = parsed.data
  const members = [...new Set((group.members ?? []).map((m) => m.value))]
  const resource: Doc = { ...doc }
  delete resource[keyIn(resource, "members", GROUP_ATTRIBUTES)]
  if (JSON.stringify(resource).length > LIMITS.resource)
    throw bad("The resource is too large.", "tooMany")
  return {
    displayName: group.displayName,
    externalId: group.externalId || null,
    members,
    resource,
  }
}

// ── PATCH (RFC 7644 3.5.2, with Entra's and Okta's dialects) ────────────────

const patchBody = z.object({
  schemas: z.array(z.string().max(256)).max(10).optional(),
  Operations: z
    .array(
      z.object({
        op: z.string().max(16),
        path: z.string().max(LIMITS.filter).optional(),
        value: z.unknown().optional(),
      }),
    )
    .min(1, "Operations is empty.")
    .max(LIMITS.operations),
})

export type PatchOp = { op: "add" | "replace" | "remove"; path?: string; value?: Json }

/**
 * The PatchOp message, its ops lowercased (Entra capitalises them).
 *
 * ⚠ THE `schemas` ENTRY IS NOT REQUIRED. RFC 7644 asks for it and Okta and
 * Entra send it, but nothing is decided by it, and refusing a body over it
 * would fail a push for nothing.
 */
export function readPatch(body: unknown): PatchOp[] {
  const parsed = patchBody.safeParse(isObject(body) ? normaliseKeys(body) : body)
  if (!parsed.success) throw bad(issue(parsed.error), "invalidSyntax")
  return parsed.data.Operations.map((o) => {
    const op = o.op.toLowerCase()
    if (op !== "add" && op !== "replace" && op !== "remove")
      throw bad(`${o.op} is not a PATCH operation.`, "invalidSyntax")
    return {
      op,
      ...(o.path !== undefined && o.path.trim() !== "" ? { path: o.path.trim() } : {}),
      ...(o.value !== undefined ? { value: boundedJson(o.value) } : {}),
    }
  })
}

/** `operations` and `Operations` alike: some clients lowercase it. */
function normaliseKeys(body: Record<string, unknown>) {
  const out: Record<string, unknown> = { ...body }
  for (const key of Object.keys(body))
    if (key.toLowerCase() === "operations" && key !== "Operations") {
      out.Operations = body[key]
      delete out[key]
    }
  if (Array.isArray(out.Operations))
    out.Operations = out.Operations.map((o: unknown) =>
      isObject(o)
        ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]))
        : o,
    )
  return out
}

interface Term {
  attr: string
  value: Json
}

interface Path {
  urn: string | null
  attr: string
  filter: Term[] | null
  sub: string | null
}

const PATH = /^([A-Za-z$][\w$-]*)(?:\[(.*)\])?(?:\.([A-Za-z$][\w$-]*))?$/

/**
 * A PATCH path: `attr`, `attr.sub`, `attr[filter]`, `attr[filter].sub`, any of
 * them behind a schema URN (`urn:...:enterprise:2.0:User:manager`).
 */
export function parsePath(raw: string, kind: Kind): Path {
  if (raw.length > LIMITS.filter) throw bad("The path is too long.", "invalidPath")
  let urn: string | null = null
  let rest = raw
  if (raw.toLowerCase().startsWith("urn:")) {
    const bracket = raw.indexOf("[")
    const head = bracket === -1 ? raw : raw.slice(0, bracket)
    const cut = head.lastIndexOf(":")
    urn = canonicalUrn(head.slice(0, cut))
    rest = raw.slice(cut + 1)
    const core = kind === "User" ? SCHEMA.user : SCHEMA.group
    if (urn === core) urn = null
    else if (kind === "Group")
      throw bad(`${raw} is not a Group attribute.`, "invalidPath")
  }
  const match = PATH.exec(rest)
  if (!match) throw bad(`${raw} is not a valid path.`, "invalidPath")
  const [, attr, filter, sub] = match as unknown as [
    string,
    string,
    string | undefined,
    string | undefined,
  ]
  return {
    urn,
    attr,
    filter: filter === undefined ? null : parseTerms(filter, raw),
    sub: sub ?? null,
  }
}

/**
 * A value filter inside a path: `eq` comparisons joined by `and`. Values are
 * JSON literals (`"work"`, `true`, `42`, `null`).
 */
function parseTerms(raw: string, path: string): Term[] {
  const terms: Term[] = []
  const TERM =
    /^\s*([A-Za-z$][\w$.-]*)\s+eq\s+("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?)\s*/i
  let rest = raw
  for (;;) {
    const m = TERM.exec(rest)
    if (!m) throw bad(`The filter in ${path} is not supported.`, "invalidPath")
    const literal = m[2]!
    const lower = literal.toLowerCase()
    terms.push({
      attr: m[1]!,
      value:
        lower === "true" || lower === "false" || lower === "null"
          ? (JSON.parse(lower) as Json)
          : (JSON.parse(literal) as Json),
    })
    rest = rest.slice(m[0].length)
    if (rest.trim() === "") return terms
    const and = /^and\s+/i.exec(rest)
    if (!and) throw bad(`The filter in ${path} is not supported.`, "invalidPath")
    rest = rest.slice(and[0].length)
  }
}

const same = (a: Json | undefined, b: Json) =>
  typeof a === "string" && typeof b === "string"
    ? a.toLowerCase() === b.toLowerCase()
    : bool(a) === bool(b)

function matches(entry: Json, terms: Term[]): boolean {
  if (!isObject(entry)) return false
  return terms.every((t) =>
    same(entry[keyIn(entry as Doc, t.attr, VALUE_PARTS)], t.value),
  )
}

const entryValue = (entry: Json): Json | undefined =>
  isObject(entry) ? (entry as Doc)[keyIn(entry as Doc, "value", VALUE_PARTS)] : entry

/** Merges `patch` into `target` (sub-attribute names case-insensitively). */
function merge(target: Doc, patch: Doc, known: readonly string[]): Doc {
  const out = { ...target }
  for (const [k, v] of Object.entries(patch)) out[keyIn(out, k, known)] = v
  return out
}

/** Only one entry of a multi-valued attribute may be primary (RFC 7643 2.4). */
function onePrimary(list: Json[], chosen: Json[]): Json[] {
  if (!chosen.some((e) => isObject(e) && bool((e as Doc).primary) === true)) return list
  return list.map((e) =>
    isObject(e) && !chosen.includes(e) && bool((e as Doc).primary) === true
      ? { ...(e as Doc), primary: false }
      : e,
  )
}

const asList = (value: Json | undefined): Json[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]

/**
 * Applies one operation at one path, in place on `doc`.
 *
 * ⚠ ENTRA'S DIALECT IS HANDLED HERE, ON PURPOSE AND BY NAME:
 *   - a filtered path with no match is MADE (`emails[type eq "work"].value`
 *     on a user with no work address adds one), for `add` and `replace`;
 *   - `remove` of a multi-valued attribute WITH a `value` list removes just
 *     those (`members`, value `[{ value: id }]`) rather than all of it;
 *   - the enterprise `manager` given as a bare id string is `{ value: id }`.
 */
function applyAt(
  doc: Doc,
  path: Path,
  op: PatchOp["op"],
  value: Json | undefined,
  kind: Kind,
) {
  const known = knownFor(path.urn, kind)
  let container: Doc
  if (path.urn) {
    const existing = doc[path.urn]
    if (!isObject(existing)) {
      if (op === "remove") return
      doc[path.urn] = {}
    }
    container = doc[path.urn] as Doc
  } else container = doc

  const lowerAttr = path.attr.toLowerCase()
  if (
    !path.urn &&
    (lowerAttr === "id" || lowerAttr === "meta" || lowerAttr === "schemas")
  )
    return readOnly(path.attr, op, value)
  if (
    !path.urn &&
    kind === "User" &&
    (lowerAttr === "groups" || lowerAttr === "password")
  )
    return
  const key = keyIn(container, path.attr, known)
  const multi = MULTI_VALUED.has(lowerAttr)

  if (op === "remove") {
    if (path.filter) {
      if (!Array.isArray(container[key])) return
      const list = container[key] as Json[]
      container[key] = path.sub
        ? list.map((e) => {
            if (!matches(e, path.filter!)) return e
            const copy = { ...(e as Doc) }
            delete copy[keyIn(copy, path.sub!, VALUE_PARTS)]
            return copy
          })
        : list.filter((e) => !matches(e, path.filter!))
      return
    }
    if (path.sub) {
      const target = container[key]
      if (isObject(target))
        delete (target as Doc)[keyIn(target as Doc, path.sub, NAME_PARTS)]
      return
    }
    if (multi && value !== undefined && Array.isArray(container[key])) {
      const drop = asList(value).map(entryValue)
      container[key] = (container[key] as Json[]).filter(
        (e) => !drop.some((d) => d !== undefined && same(entryValue(e), d as Json)),
      )
      return
    }
    delete container[key]
    return
  }

  if (value === undefined) throw bad(`${op} needs a value.`, "invalidValue")

  if (path.filter) {
    const list = Array.isArray(container[key]) ? [...(container[key] as Json[])] : []
    let hits = list.filter((e) => matches(e, path.filter!))
    if (hits.length === 0) {
      const made: Doc = {}
      for (const t of path.filter) made[canonical(t.attr, VALUE_PARTS)] = t.value
      list.push(made)
      hits = [made]
    }
    const next = list.map((e) => {
      if (!hits.includes(e)) return e
      if (path.sub)
        return { ...(e as Doc), [keyIn(e as Doc, path.sub, VALUE_PARTS)]: value }
      if (!isObject(value)) throw bad(`${key} needs an object here.`)
      return merge(e as Doc, value as Doc, VALUE_PARTS)
    })
    const chosen = next.filter((e, i) => hits.includes(list[i]!))
    container[key] = onePrimary(next, chosen)
    return
  }

  if (path.sub) {
    const current = container[key]
    if (Array.isArray(current))
      throw bad(`${key}.${path.sub} needs a filter.`, "invalidPath")
    const target: Doc = isObject(current) ? { ...(current as Doc) } : {}
    target[keyIn(target, path.sub, key === "name" ? NAME_PARTS : VALUE_PARTS)] = value
    container[key] = target
    return
  }

  if (multi) {
    const incoming = asList(value)
    if (op === "replace") {
      container[key] = onePrimary(incoming, incoming)
      return
    }
    const list = Array.isArray(container[key]) ? [...(container[key] as Json[])] : []
    for (const item of incoming) {
      const v = entryValue(item)
      if (v !== undefined && list.some((e) => same(entryValue(e), v as Json))) continue
      list.push(item)
    }
    container[key] = onePrimary(list, incoming)
    return
  }

  if (
    path.urn === SCHEMA.enterprise &&
    key === "manager" &&
    typeof value === "string"
  ) {
    container[key] = { value }
    return
  }
  const current = container[key]
  container[key] =
    isObject(current) && isObject(value)
      ? merge(current as Doc, value as Doc, key === "name" ? NAME_PARTS : VALUE_PARTS)
      : value
}

/** `id`, `meta` and `schemas` are readOnly: the same id is accepted, anything else refused. */
function readOnly(attr: string, op: PatchOp["op"], value: Json | undefined) {
  if (attr.toLowerCase() !== "id") return
  if (op === "remove" || value !== undefined)
    throw new ScimError(400, "id cannot be changed.", "mutability")
}

/**
 * A path-less add or replace: `value` is a fragment of the resource. Each of
 * its keys is applied as a path of its own, which is RFC 7644's merge for a
 * plain key and also reads Entra's keys that ARE paths (`name.givenName`,
 * `emails[type eq "work"].value`, `urn:...:enterprise:2.0:User:department`).
 * An extension URN with an object is merged attribute by attribute.
 *
 * ⚠ OKTA SENDS `id` IN THE VALUE (`{"id": "...", "displayName": "..."}`).
 * The resource's own id is ignored there; another id is refused.
 */
function applyFragment(
  doc: Doc,
  op: "add" | "replace",
  value: Json,
  kind: Kind,
  id: string,
) {
  if (!isObject(value))
    throw bad("A PATCH without a path needs an object value.", "invalidSyntax")
  for (const [key, v] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (lower === "id") {
      if (v !== id) throw new ScimError(400, "id cannot be changed.", "mutability")
      continue
    }
    if (lower === "schemas" || lower === "meta") continue
    if (
      lower.startsWith("urn:") &&
      isObject(v) &&
      !/[[.]/.test(key.slice(key.lastIndexOf(":")))
    ) {
      const urn = canonicalUrn(key)
      const core = kind === "User" ? SCHEMA.user : SCHEMA.group
      if (urn === core) {
        applyFragment(doc, op, v, kind, id)
        continue
      }
      if (kind === "Group") throw bad(`${key} is not a Group extension.`, "invalidPath")
      const ext = isObject(doc[urn]) ? (doc[urn] as Doc) : {}
      doc[urn] = ext
      for (const [k, sub] of Object.entries(v))
        applyAt(doc, { urn, attr: k, filter: null, sub: null }, op, sub as Json, kind)
      continue
    }
    applyAt(doc, parsePath(key, kind), op, v as Json, kind)
  }
}

/**
 * Applies a PATCH to a stored resource and reads the result back through the
 * same rules a PUT meets.
 *
 * ⚠ ALL OR NOTHING. The operations run on a copy; the first one that fails
 * refuses the whole request and nothing is stored (RFC 7644 3.5.2).
 */
export function patchUser(
  stored: Record<string, unknown>,
  ops: PatchOp[],
  id: string,
): StoredUser {
  const doc = structuredClone(stored) as Doc
  for (const o of ops) step(doc, o, "User", id)
  return finishUser(coerce(doc))
}

export function patchGroup(
  stored: Record<string, unknown>,
  members: string[],
  ops: PatchOp[],
  id: string,
): StoredGroup {
  const doc = structuredClone(stored) as Doc
  doc.members = members.map((value) => ({ value }))
  for (const o of ops) step(doc, o, "Group", id)
  return finishGroup(doc)
}

function step(doc: Doc, o: PatchOp, kind: Kind, id: string) {
  if (o.path === undefined) {
    if (o.op === "remove") throw bad("remove needs a path.", "noTarget")
    if (o.value === undefined) throw bad(`${o.op} needs a value.`, "invalidValue")
    applyFragment(doc, o.op, o.value, kind, id)
    return
  }
  applyAt(doc, parsePath(o.path, kind), o.op, o.value, kind)
}

// ── Views ───────────────────────────────────────────────────────────────────

export interface UserRowView {
  id: string
  userName: string
  externalId: string | null
  active: boolean
  resource: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface GroupRowView {
  id: string
  displayName: string
  externalId: string | null
  resource: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

/** A User as SCIM returns it. */
export function userResource(
  row: UserRowView,
  groups: { id: string; displayName: string }[],
  base: string,
): Record<string, unknown> {
  const resource = { ...row.resource }
  const extensions = Object.keys(resource).filter((k) =>
    k.toLowerCase().startsWith("urn:"),
  )
  return {
    schemas: [SCHEMA.user, ...extensions],
    id: row.id,
    ...resource,
    userName: row.userName,
    ...(row.externalId ? { externalId: row.externalId } : {}),
    active: row.active,
    groups: groups.map((g) => ({
      value: g.id,
      display: g.displayName,
      $ref: `${base}/Groups/${g.id}`,
    })),
    meta: {
      resourceType: "User",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      location: `${base}/Users/${row.id}`,
    },
  }
}

/** A Group as SCIM returns it. */
export function groupResource(
  row: GroupRowView,
  members: { id: string; display: string }[],
  base: string,
): Record<string, unknown> {
  return {
    schemas: [SCHEMA.group],
    id: row.id,
    ...row.resource,
    displayName: row.displayName,
    ...(row.externalId ? { externalId: row.externalId } : {}),
    members: members.map((m) => ({
      value: m.id,
      display: m.display,
      type: "User",
      $ref: `${base}/Users/${m.id}`,
    })),
    meta: {
      resourceType: "Group",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      location: `${base}/Groups/${row.id}`,
    },
  }
}

// ── Discovery (RFC 7644 4) ──────────────────────────────────────────────────

export function serviceProviderConfig(base: string) {
  return {
    schemas: [SCHEMA.serviceProviderConfig],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: LIMITS.maxCount },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description:
          "The directory's token from the i10 console, as Authorization: Bearer.",
        primary: true,
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: `${base}/ServiceProviderConfig`,
    },
  }
}

export function resourceTypes(base: string) {
  return [
    {
      schemas: [SCHEMA.resourceType],
      id: "User",
      name: "User",
      endpoint: "/Users",
      description: "A person in the workspace.",
      schema: SCHEMA.user,
      schemaExtensions: [{ schema: SCHEMA.enterprise, required: false }],
      meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` },
    },
    {
      schemas: [SCHEMA.resourceType],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      description: "A group of people in the workspace's directory.",
      schema: SCHEMA.group,
      meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/Group` },
    },
  ]
}

type AttrType = "string" | "boolean" | "complex" | "reference" | "dateTime" | "integer"

interface SchemaAttribute {
  name: string
  type: AttrType
  multiValued: boolean
  description: string
  required: boolean
  caseExact: boolean
  mutability: string
  returned: string
  uniqueness: string
  subAttributes?: SchemaAttribute[]
}

function attr(
  name: string,
  type: AttrType,
  o: {
    multi?: boolean
    required?: boolean
    mutability?: "readOnly" | "readWrite" | "immutable" | "writeOnly"
    returned?: "always" | "never" | "default" | "request"
    uniqueness?: "none" | "server" | "global"
    sub?: SchemaAttribute[]
  } = {},
): SchemaAttribute {
  return {
    name,
    type,
    multiValued: o.multi ?? false,
    description: name,
    required: o.required ?? false,
    caseExact: false,
    mutability: o.mutability ?? "readWrite",
    returned: o.returned ?? "default",
    uniqueness: o.uniqueness ?? "none",
    ...(o.sub ? { subAttributes: o.sub } : {}),
  }
}

const valueParts = (extra: SchemaAttribute[] = []) => [
  attr("value", "string"),
  attr("display", "string"),
  attr("type", "string"),
  attr("primary", "boolean"),
  ...extra,
]

export function schemas(base: string) {
  const meta = (id: string) => ({
    resourceType: "Schema",
    location: `${base}/Schemas/${id}`,
  })
  return [
    {
      schemas: [SCHEMA.schema],
      id: SCHEMA.user,
      name: "User",
      description: "User Account",
      attributes: [
        attr("userName", "string", { required: true, uniqueness: "server" }),
        attr("name", "complex", { sub: NAME_PARTS.map((p) => attr(p, "string")) }),
        attr("displayName", "string"),
        attr("nickName", "string"),
        attr("profileUrl", "reference"),
        attr("title", "string"),
        attr("userType", "string"),
        attr("preferredLanguage", "string"),
        attr("locale", "string"),
        attr("timezone", "string"),
        attr("active", "boolean"),
        attr("password", "string", { mutability: "writeOnly", returned: "never" }),
        attr("emails", "complex", { multi: true, sub: valueParts() }),
        attr("phoneNumbers", "complex", { multi: true, sub: valueParts() }),
        attr("addresses", "complex", { multi: true, sub: valueParts() }),
        attr("groups", "complex", {
          multi: true,
          mutability: "readOnly",
          sub: [
            attr("value", "string"),
            attr("$ref", "reference"),
            attr("display", "string"),
          ],
        }),
        attr("roles", "complex", { multi: true, sub: valueParts() }),
        attr("entitlements", "complex", { multi: true, sub: valueParts() }),
      ],
      meta: meta(SCHEMA.user),
    },
    {
      schemas: [SCHEMA.schema],
      id: SCHEMA.group,
      name: "Group",
      description: "Group",
      attributes: [
        attr("displayName", "string", { required: true }),
        attr("members", "complex", {
          multi: true,
          sub: [
            attr("value", "string", { mutability: "immutable" }),
            attr("$ref", "reference", { mutability: "immutable" }),
            attr("display", "string"),
            attr("type", "string", { mutability: "immutable" }),
          ],
        }),
      ],
      meta: meta(SCHEMA.group),
    },
    {
      schemas: [SCHEMA.schema],
      id: SCHEMA.enterprise,
      name: "EnterpriseUser",
      description: "Enterprise User",
      attributes: [
        attr("employeeNumber", "string"),
        attr("costCenter", "string"),
        attr("organization", "string"),
        attr("division", "string"),
        attr("department", "string"),
        attr("manager", "complex", {
          sub: [
            attr("value", "string"),
            attr("$ref", "reference"),
            attr("displayName", "string"),
          ],
        }),
      ],
      meta: meta(SCHEMA.enterprise),
    },
  ]
}

// ── Tokens ──────────────────────────────────────────────────────────────────

/** Every SCIM token starts with this, so a leak scan can find one. */
export const TOKEN_PREFIX = "i10_scim_"

const TOKEN = /^i10_scim_[A-Za-z0-9_-]{43}$/

/**
 * A token in our format, or null. Checked before it is hashed.
 *
 * ⚠ THE `Bearer ` PREFIX IS OPTIONAL. Okta's header-auth SCIM sends the field
 * verbatim (`Authorization: i10_scim_...`, probed 2026-11-02), Entra sends
 * `Bearer i10_scim_...`. Our prefix makes a bare value unambiguous.
 */
export function readToken(header: string | undefined): string | null {
  if (!header || header.length > 128) return null
  const match = /^(?:Bearer\s+)?(\S+)\s*$/i.exec(header)
  const token = match?.[1]
  return token && TOKEN.test(token) ? token : null
}
