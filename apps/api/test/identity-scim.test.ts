import { describe, expect, it } from "bun:test"
import {
  LIMITS,
  SCHEMA,
  ScimError,
  TOKEN_PREFIX,
  boundedJson,
  errorBody,
  groupResource,
  listResponse,
  parseFilter,
  patchGroup,
  patchUser,
  primaryEmail,
  project,
  readGroup,
  readListQuery,
  readPatch,
  readProjection,
  readToken,
  readUser,
  resourceTypes,
  schemas,
  serviceProviderConfig,
  userResource,
  type StoredUser,
} from "../src/identity/scim.js"

/**
 * The SCIM protocol layer (#342): filters, pagination, projection, resource
 * parsing and PATCH, with payloads shaped as Entra, Okta and Google send them.
 * Refusals first, then what is accepted.
 */

const ID = "99999999-9999-4999-8999-999999999999"
const refusal = (run: () => unknown): ScimError => {
  try {
    run()
  } catch (error) {
    if (error instanceof ScimError) return error
    throw error
  }
  throw new Error("expected a refusal")
}

// ── What Entra, Okta and Google actually send ───────────────────────────────

const ENTRA_USER = {
  schemas: [SCHEMA.user, SCHEMA.enterprise],
  externalId: "8b0e5b2c-5a41-4a5f-9a52-2c2f3b6c1a10",
  userName: "Ada.Lovelace@acme.test",
  active: true,
  displayName: "Ada Lovelace",
  meta: { resourceType: "User" },
  name: { givenName: "Ada", familyName: "Lovelace", formatted: "Ada Lovelace" },
  emails: [{ primary: true, type: "work", value: "Ada.Lovelace@acme.test" }],
  [SCHEMA.enterprise]: {
    department: "Engineering",
    employeeNumber: "1815",
    manager: { value: "2c0d6a64-4b8f-4b1b-b1e7-0c6b8f6f9d11", displayName: "Charles" },
  },
}

/** Entra's older dialect (no aadOptscim062020): booleans as strings. */
const ENTRA_USER_STRINGS = {
  ...ENTRA_USER,
  active: "True",
  emails: [{ primary: "True", type: "work", value: "Ada.Lovelace@acme.test" }],
}

const OKTA_USER = {
  schemas: [SCHEMA.user],
  userName: "grace@acme.test",
  name: { givenName: "Grace", familyName: "Hopper" },
  emails: [{ primary: true, value: "grace@acme.test", type: "work" }],
  displayName: "Grace Hopper",
  locale: "en-US",
  externalId: "00u1abcd2EFGhij3k4l5",
  groups: [],
  password: "must-never-be-stored",
  active: true,
}

const GOOGLE_USER = {
  schemas: [SCHEMA.user],
  userName: "alan@acme.test",
  name: { givenName: "Alan", familyName: "Turing" },
  emails: [{ value: "alan@acme.test", primary: true }],
  active: true,
}

const PATCH_SCHEMA = [SCHEMA.patch]
const ops = (...operations: Record<string, unknown>[]) =>
  readPatch({ schemas: PATCH_SCHEMA, Operations: operations })

const patched = (stored: StoredUser, ...operations: Record<string, unknown>[]) =>
  patchUser(stored.resource, ops(...operations), ID)

// ── Filters ─────────────────────────────────────────────────────────────────

describe("filters: what is refused", () => {
  for (const filter of [
    "userName pr",
    'userName co "ada"',
    'userName sw "ada"',
    'userName ne "ada"',
    'userName eq "a" and active eq true',
    'userName eq "a" or userName eq "b"',
    '(userName eq "a")',
    'not (userName eq "a")',
    'emails[type eq "work"].value eq "a@b.test"',
    'name.givenName eq "Ada"',
    "active eq true",
    "userName eq ada",
    'userName eq "unterminated',
    "",
    "   ",
    "eq",
    'userName eq "a" garbage',
  ])
    it(`refuses ${JSON.stringify(filter)} as invalidFilter, never as "no filter"`, () => {
      const error = refusal(() => parseFilter(filter, "User"))
      expect(error.status).toBe(400)
      expect(error.scimType).toBe("invalidFilter")
    })

  it("refuses a filter on a Group attribute that is not displayName or externalId", () => {
    expect(refusal(() => parseFilter('members.value eq "x"', "Group")).scimType).toBe(
      "invalidFilter",
    )
    expect(refusal(() => parseFilter('userName eq "x"', "Group")).scimType).toBe(
      "invalidFilter",
    )
  })

  it("refuses a filter longer than the limit and a value longer than a string may be", () => {
    expect(
      refusal(() => parseFilter(`userName eq "${"a".repeat(LIMITS.filter)}"`, "User"))
        .scimType,
    ).toBe("invalidFilter")
    expect(
      refusal(() =>
        parseFilter(`userName eq "${"a".repeat(LIMITS.string + 1)}"`, "User"),
      ).scimType,
    ).toBe("invalidFilter")
  })

  it("refuses a value that is not a JSON string", () => {
    expect(refusal(() => parseFilter('userName eq "\\x"', "User")).scimType).toBe(
      "invalidFilter",
    )
  })
})

describe("filters: what is answered", () => {
  it("reads the comparisons the three IdPs send", () => {
    expect(parseFilter('userName eq "ada@acme.test"', "User")).toEqual({
      attr: "userName",
      value: "ada@acme.test",
    })
    // Entra probes a GUID as a userName and expects an empty list.
    expect(
      parseFilter('userName eq "8b0e5b2c-5a41-4a5f-9a52-2c2f3b6c1a10"', "User"),
    ).toEqual({
      attr: "userName",
      value: "8b0e5b2c-5a41-4a5f-9a52-2c2f3b6c1a10",
    })
    expect(parseFilter('externalId eq "00u1abcd2EFGhij3k4l5"', "User")?.attr).toBe(
      "externalId",
    )
    expect(parseFilter('emails.value eq "a@b.test"', "User")?.attr).toBe("emails.value")
    expect(parseFilter('displayName eq "Engineers"', "Group")).toEqual({
      attr: "displayName",
      value: "Engineers",
    })
    expect(parseFilter('externalId eq "g-1"', "Group")?.attr).toBe("externalId")
  })

  it("is case-insensitive about the attribute and the operator, and accepts the core URN prefix", () => {
    expect(parseFilter('USERNAME EQ "x"', "User")?.attr).toBe("userName")
    expect(parseFilter(`${SCHEMA.user}:userName eq "x"`, "User")?.attr).toBe("userName")
    expect(parseFilter(`${SCHEMA.group}:displayName eq "x"`, "Group")?.attr).toBe(
      "displayName",
    )
  })

  it("keeps escapes in the value and answers no filter for none", () => {
    expect(parseFilter('userName eq "a\\"b"', "User")?.value).toBe('a"b')
    expect(parseFilter(undefined, "User")).toBeNull()
  })
})

// ── Pagination and projection ───────────────────────────────────────────────

describe("list queries", () => {
  it("refuses a startIndex or count that is not a number", () => {
    expect(refusal(() => readListQuery({ startIndex: "abc" })).status).toBe(400)
    expect(refusal(() => readListQuery({ count: "1e3" })).status).toBe(400)
    expect(refusal(() => readListQuery({ count: "99999999999999" })).status).toBe(400)
  })

  it("refuses an oversized filter and too many projected attributes", () => {
    expect(
      refusal(() => readListQuery({ filter: "x".repeat(LIMITS.filter + 1) })).status,
    ).toBe(400)
    const many = Array.from({ length: 51 }, (_, i) => `a${i}`).join(",")
    expect(refusal(() => readListQuery({ attributes: many })).scimType).toBe("tooMany")
  })

  it("floors startIndex at 1 and a negative count at 0, and caps count", () => {
    expect(readListQuery({ startIndex: "0" }).startIndex).toBe(1)
    expect(readListQuery({ startIndex: "-5" }).startIndex).toBe(1)
    expect(readListQuery({ count: "-1" }).count).toBe(0)
    expect(readListQuery({ count: "100000" }).count).toBe(LIMITS.maxCount)
    expect(readListQuery({}).count).toBe(LIMITS.defaultCount)
    expect(readListQuery({}).startIndex).toBe(1)
  })

  it("ignores query parameters it does not know (Entra appends aadOptscim062020)", () => {
    const q = readListQuery({ aadOptscim062020: "", startIndex: "3", unknown: "x" })
    expect(q.startIndex).toBe(3)
  })

  it("projects attributes and excluded attributes, always keeping id, schemas and meta", () => {
    const resource = {
      schemas: [SCHEMA.user],
      id: ID,
      userName: "a",
      displayName: "A",
      emails: [],
      meta: { resourceType: "User" },
      [SCHEMA.enterprise]: { department: "x" },
    }
    expect(
      Object.keys(project(resource, { attributes: ["userName"], excluded: [] })).sort(),
    ).toEqual(["id", "meta", "schemas", "userName"])
    expect(
      Object.keys(
        project(resource, { attributes: [], excluded: ["emails", "displayName"] }),
      ).sort(),
    ).toEqual(
      [
        "id",
        "meta",
        "schemas",
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
        "userName",
      ].sort(),
    )
    expect(
      Object.keys(
        project(resource, {
          attributes: ["name.givenName", SCHEMA.enterprise],
          excluded: [],
        }),
      ).sort(),
    ).toEqual(["id", "meta", "schemas", SCHEMA.enterprise].sort())
    const group = {
      id: ID,
      schemas: [SCHEMA.group],
      displayName: "G",
      members: [{ value: "1" }],
      meta: {},
    }
    expect(
      project(group, readProjection({ excludedAttributes: "members" })).members,
    ).toBeUndefined()
    expect(project(resource, { attributes: [], excluded: [] })).toBe(resource)
  })

  it("builds a ListResponse", () => {
    expect(listResponse([{ id: "1" }], 7, 3)).toEqual({
      schemas: [SCHEMA.list],
      totalResults: 7,
      itemsPerPage: 1,
      startIndex: 3,
      Resources: [{ id: "1" }],
    })
  })
})

// ── JSON hygiene ────────────────────────────────────────────────────────────

describe("bounded json", () => {
  it("refuses nesting past the limit, a string past the limit and an array past the limit", () => {
    let deep: unknown = "x"
    for (let i = 0; i < LIMITS.depth + 2; i++) deep = { a: deep }
    expect(refusal(() => boundedJson(deep)).scimType).toBe("invalidSyntax")
    expect(refusal(() => boundedJson("x".repeat(LIMITS.string + 1))).status).toBe(400)
    expect(
      refusal(() => boundedJson(new Array(LIMITS.members + 1).fill(1))).scimType,
    ).toBe("tooMany")
    expect(refusal(() => boundedJson({ ["k".repeat(513)]: 1 })).status).toBe(400)
  })

  it("never copies __proto__, constructor or prototype keys", () => {
    const hostile = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": 1, "a": 2}',
    )
    const out = boundedJson(hostile) as Record<string, unknown>
    expect(Object.keys(out)).toEqual(["a"])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

// ── Reading a User ──────────────────────────────────────────────────────────

describe("reading a User: what is refused", () => {
  it("needs a body that is an object", () => {
    expect(refusal(() => readUser([])).scimType).toBe("invalidSyntax")
    expect(refusal(() => readUser("x")).scimType).toBe("invalidSyntax")
    expect(refusal(() => readUser(null)).scimType).toBe("invalidSyntax")
  })

  it("needs a userName", () => {
    expect(refusal(() => readUser({ active: true })).status).toBe(400)
    expect(refusal(() => readUser({ userName: "   " })).status).toBe(400)
    expect(refusal(() => readUser({ userName: 5 })).status).toBe(400)
  })

  it("refuses an active that is not a boolean", () => {
    expect(refusal(() => readUser({ userName: "a", active: "maybe" })).status).toBe(400)
    expect(refusal(() => readUser({ userName: "a", active: 1 })).status).toBe(400)
  })

  it("refuses a name or an email that is too long, too many emails, and an email without a value", () => {
    expect(
      refusal(() => readUser({ userName: "a".repeat(LIMITS.name + 1) })).status,
    ).toBe(400)
    expect(
      refusal(() => readUser({ userName: "a", emails: [{ value: "x".repeat(321) }] }))
        .status,
    ).toBe(400)
    expect(
      refusal(() =>
        readUser({
          userName: "a",
          emails: Array.from({ length: LIMITS.multi + 1 }, (_, i) => ({
            value: `a${i}@x.test`,
          })),
        }),
      ).status,
    ).toBe(400)
    expect(
      refusal(() => readUser({ userName: "a", emails: [{ type: "work" }] })).status,
    ).toBe(400)
  })

  it("refuses a resource larger than the stored limit", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`custom${i}`, "x".repeat(LIMITS.string)]),
    )
    expect(refusal(() => readUser({ userName: "a", ...wide })).scimType).toBe("tooMany")
  })
})

describe("reading a User: what is kept", () => {
  it("reads Entra's user with its enterprise extension", () => {
    const stored = readUser(ENTRA_USER)
    expect(stored).toMatchObject({
      userName: "Ada.Lovelace@acme.test",
      externalId: "8b0e5b2c-5a41-4a5f-9a52-2c2f3b6c1a10",
      displayName: "Ada Lovelace",
      givenName: "Ada",
      familyName: "Lovelace",
      email: "ada.lovelace@acme.test",
      active: true,
    })
    expect(stored.resource[SCHEMA.enterprise]).toMatchObject({
      department: "Engineering",
      employeeNumber: "1815",
      manager: { value: "2c0d6a64-4b8f-4b1b-b1e7-0c6b8f6f9d11" },
    })
  })

  it("reads Entra's string booleans", () => {
    const stored = readUser(ENTRA_USER_STRINGS)
    expect(stored.active).toBe(true)
    expect((stored.resource.emails as { primary: unknown }[])[0]!.primary).toBe(true)
    expect(readUser({ userName: "a", active: "False" }).active).toBe(false)
  })

  it("reads Okta's user, dropping the password, the groups and the id it must never store", () => {
    const stored = readUser({ ...OKTA_USER, id: "attacker-chosen", meta: { x: 1 } })
    expect(stored.email).toBe("grace@acme.test")
    expect(stored.resource).not.toHaveProperty("password")
    expect(stored.resource).not.toHaveProperty("groups")
    expect(stored.resource).not.toHaveProperty("id")
    expect(stored.resource).not.toHaveProperty("meta")
    expect(stored.resource).not.toHaveProperty("schemas")
    expect(JSON.stringify(stored)).not.toContain("must-never-be-stored")
    expect(stored.resource.locale).toBe("en-US")
  })

  it("reads Google's minimal user, and defaults active to true", () => {
    const withoutActive: Record<string, unknown> = { ...GOOGLE_USER }
    delete withoutActive.active
    const stored = readUser(withoutActive)
    expect(stored.active).toBe(true)
    expect(stored.givenName).toBe("Alan")
  })

  it("puts attribute names in their canonical case and reads the core-URN form", () => {
    const stored = readUser({
      USERNAME: "a@acme.test",
      DisplayName: "A",
      [SCHEMA.user.toUpperCase()]: { externalid: "e-1" },
    })
    expect(stored.userName).toBe("a@acme.test")
    expect(stored.displayName).toBe("A")
    expect(stored.externalId).toBe("e-1")
  })

  it("keeps custom attributes and unknown extensions as sent", () => {
    const stored = readUser({
      userName: "a",
      title: "Engineer",
      "urn:example:custom:1.0:User": { badge: "B-7" },
    })
    expect(stored.resource.title).toBe("Engineer")
    expect(stored.resource["urn:example:custom:1.0:User"]).toEqual({ badge: "B-7" })
  })

  it("picks the primary address, else the work one, else the first, else a userName that is one", () => {
    const e = (value: string, extra: object = {}) => ({ value, ...extra })
    expect(primaryEmail([e("a@x.test"), e("b@x.test", { primary: true })], "u")).toBe(
      "b@x.test",
    )
    expect(primaryEmail([e("a@x.test"), e("w@x.test", { type: "Work" })], "u")).toBe(
      "w@x.test",
    )
    expect(primaryEmail([e("a@x.test"), e("b@x.test")], "u")).toBe("a@x.test")
    expect(primaryEmail([], "Okta.User@Acme.Test")).toBe("okta.user@acme.test")
    expect(primaryEmail([], "not an address")).toBeNull()
    expect(primaryEmail([e("not an address")], "u@x.test")).toBeNull()
  })
})

// ── PATCH ───────────────────────────────────────────────────────────────────

describe("PATCH: what is refused", () => {
  it("refuses a body without Operations, with an empty list, or with an unknown op", () => {
    expect(refusal(() => readPatch({ schemas: PATCH_SCHEMA })).scimType).toBe(
      "invalidSyntax",
    )
    expect(refusal(() => readPatch({ Operations: [] })).scimType).toBe("invalidSyntax")
    expect(
      refusal(() => readPatch({ Operations: [{ op: "move", path: "x" }] })).scimType,
    ).toBe("invalidSyntax")
    expect(refusal(() => readPatch("x")).scimType).toBe("invalidSyntax")
    expect(
      refusal(() =>
        readPatch({
          Operations: Array.from({ length: LIMITS.operations + 1 }, () => ({
            op: "add",
            path: "title",
            value: "x",
          })),
        }),
      ).scimType,
    ).toBe("invalidSyntax")
  })

  const user = () => readUser(OKTA_USER)

  it("refuses remove without a path, and add or replace without a value", () => {
    expect(refusal(() => patched(user(), { op: "remove" })).scimType).toBe("noTarget")
    expect(refusal(() => patched(user(), { op: "add", path: "title" })).scimType).toBe(
      "invalidValue",
    )
    expect(
      refusal(() => patched(user(), { op: "replace", value: undefined })).scimType,
    ).toBe("invalidValue")
  })

  it("refuses a path-less value that is not an object", () => {
    expect(refusal(() => patched(user(), { op: "replace", value: "x" })).scimType).toBe(
      "invalidSyntax",
    )
  })

  it("refuses to change the id, by path or in a value", () => {
    expect(
      refusal(() => patched(user(), { op: "replace", path: "id", value: "other" }))
        .scimType,
    ).toBe("mutability")
    expect(refusal(() => patched(user(), { op: "remove", path: "id" })).scimType).toBe(
      "mutability",
    )
    expect(
      refusal(() => patched(user(), { op: "replace", value: { id: "other" } }))
        .scimType,
    ).toBe("mutability")
  })

  it("refuses a path it cannot read, and a filter it does not support", () => {
    expect(
      refusal(() => patched(user(), { op: "add", path: "emails[", value: {} }))
        .scimType,
    ).toBe("invalidPath")
    expect(
      refusal(() => patched(user(), { op: "remove", path: 'emails[type co "w"]' }))
        .scimType,
    ).toBe("invalidPath")
    expect(
      refusal(() => ops({ op: "add", path: "t".repeat(LIMITS.filter + 1), value: "x" }))
        .scimType,
    ).toBe("invalidSyntax")
  })

  it("refuses sub-attribute writes on a multi-valued attribute with no filter", () => {
    expect(
      refusal(() =>
        patched(user(), { op: "replace", path: "emails.value", value: "x@y.test" }),
      ).scimType,
    ).toBe("invalidPath")
  })

  it("is all or nothing: a later bad op leaves nothing applied", () => {
    const stored = user()
    const before = JSON.stringify(stored.resource)
    expect(() =>
      patchUser(
        stored.resource,
        ops(
          { op: "replace", path: "title", value: "Boss" },
          { op: "replace", path: "active", value: "banana" },
        ),
        ID,
      ),
    ).toThrow()
    expect(JSON.stringify(stored.resource)).toBe(before)
  })

  it("re-validates the result: an op cannot leave the user without a userName", () => {
    expect(
      refusal(() => patched(user(), { op: "remove", path: "userName" })).status,
    ).toBe(400)
    expect(
      refusal(() => patched(user(), { op: "replace", path: "userName", value: "" }))
        .status,
    ).toBe(400)
  })

  it("ignores writes to groups and password, which are not ours to store", () => {
    const out = patched(
      user(),
      { op: "add", path: "password", value: "hunter2" },
      { op: "add", path: "groups", value: [{ value: "g" }] },
    )
    expect(JSON.stringify(out.resource)).not.toContain("hunter2")
    expect(out.resource).not.toHaveProperty("groups")
  })

  it("refuses an extension on a group", () => {
    const group = readGroup({ displayName: "G" })
    expect(
      refusal(() =>
        patchGroup(
          group.resource,
          [],
          ops({ op: "add", path: `${SCHEMA.enterprise}:department`, value: "x" }),
          ID,
        ),
      ).scimType,
    ).toBe("invalidPath")
  })
})

describe("PATCH: RFC 7644", () => {
  const user = () => readUser(OKTA_USER)

  it("replaces and adds simple attributes, and removes them", () => {
    const out = patched(
      user(),
      { op: "replace", path: "displayName", value: "G. Hopper" },
      { op: "add", path: "title", value: "Rear Admiral" },
      { op: "remove", path: "locale" },
    )
    expect(out.displayName).toBe("G. Hopper")
    expect(out.resource.title).toBe("Rear Admiral")
    expect(out.resource).not.toHaveProperty("locale")
  })

  it("replaces a sub-attribute by path", () => {
    const out = patched(user(), {
      op: "replace",
      path: "name.givenName",
      value: "Amazing",
    })
    expect(out.givenName).toBe("Amazing")
    expect(out.familyName).toBe("Hopper")
  })

  it("replaces an entry of a multi-valued attribute chosen by a filter, keeping one primary", () => {
    const base = readUser({
      userName: "u",
      emails: [
        { value: "work@acme.test", type: "work", primary: true },
        { value: "home@acme.test", type: "home" },
      ],
    })
    const out = patched(base, {
      op: "replace",
      path: 'emails[type eq "home"]',
      value: { value: "new-home@acme.test", primary: true },
    })
    const emails = out.resource.emails as { value: string; primary?: boolean }[]
    expect(emails.map((e) => e.value)).toEqual(["work@acme.test", "new-home@acme.test"])
    expect(emails.filter((e) => e.primary === true)).toHaveLength(1)
    expect(out.email).toBe("new-home@acme.test")
  })

  it("removes an entry by filter, and removing what is already gone is a no-op", () => {
    const base = readUser({
      userName: "u@acme.test",
      emails: [
        { value: "a@acme.test", type: "work" },
        { value: "b@acme.test", type: "home" },
      ],
    })
    const out = patched(base, { op: "remove", path: 'emails[type eq "home"]' })
    expect((out.resource.emails as unknown[]).length).toBe(1)
    expect(() =>
      patched(out, { op: "remove", path: 'emails[type eq "home"]' }),
    ).not.toThrow()
    expect(() => patched(out, { op: "remove", path: "phoneNumbers" })).not.toThrow()
    expect(() =>
      patched(out, { op: "remove", path: `${SCHEMA.enterprise}:manager` }),
    ).not.toThrow()
  })

  it("adds to a multi-valued attribute without duplicating a value it has", () => {
    const base = readUser({
      userName: "u@acme.test",
      emails: [{ value: "a@acme.test" }],
    })
    const out = patched(base, {
      op: "add",
      path: "emails",
      value: [{ value: "a@acme.test" }, { value: "c@acme.test", type: "other" }],
    })
    expect((out.resource.emails as { value: string }[]).map((e) => e.value)).toEqual([
      "a@acme.test",
      "c@acme.test",
    ])
  })

  it("applies a path-less fragment key by key (RFC 3.5.2.1)", () => {
    const out = patched(user(), {
      op: "add",
      value: { displayName: "H", title: "T", "name.familyName": "H." },
    })
    expect(out).toMatchObject({ displayName: "H", familyName: "H." })
    expect(out.resource.title).toBe("T")
  })

  it("matches attribute names and operations case-insensitively, and accepts a lowercase operations key", () => {
    const out = patchUser(
      user().resource,
      readPatch({ operations: [{ OP: "REPLACE", PATH: "DISPLAYNAME", VALUE: "X" }] }),
      ID,
    )
    expect(out.displayName).toBe("X")
  })
})

describe("PATCH: Entra's dialect", () => {
  const user = () => readUser(ENTRA_USER)

  it("deactivates with a capitalised op and a string boolean", () => {
    const out = patched(user(), { op: "Replace", path: "active", value: "False" })
    expect(out.active).toBe(false)
    expect(patched(out, { op: "Replace", path: "active", value: "True" }).active).toBe(
      true,
    )
  })

  it('creates a filtered entry that is not there yet (emails[type eq "work"].value)', () => {
    const base = readUser({
      userName: "u",
      emails: [{ value: "home@acme.test", type: "home" }],
    })
    const out = patched(base, {
      op: "Add",
      path: 'emails[type eq "work"].value',
      value: "work@acme.test",
    })
    expect(out.resource.emails).toEqual([
      { value: "home@acme.test", type: "home" },
      { type: "work", value: "work@acme.test" },
    ])
  })

  it("replaces the value of the existing filtered entry", () => {
    const out = patched(user(), {
      op: "Replace",
      path: 'emails[type eq "work"].value',
      value: "ada.new@acme.test",
    })
    expect(out.email).toBe("ada.new@acme.test")
    expect((out.resource.emails as unknown[]).length).toBe(1)
  })

  it("reads a path-less value object whose keys are paths", () => {
    const out = patched(user(), {
      op: "Replace",
      value: {
        "name.givenName": "Augusta",
        'emails[type eq "work"].value': "augusta@acme.test",
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department":
          "Analytics",
        active: "True",
      },
    })
    expect(out.givenName).toBe("Augusta")
    expect(out.email).toBe("augusta@acme.test")
    expect(out.resource[SCHEMA.enterprise]).toMatchObject({ department: "Analytics" })
  })

  it("sets the manager from a bare id string", () => {
    const out = patched(user(), {
      op: "Add",
      path: `${SCHEMA.enterprise}:manager`,
      value: "5f4d0c1e-0000-4000-8000-000000000001",
    })
    expect((out.resource[SCHEMA.enterprise] as { manager: unknown }).manager).toEqual({
      value: "5f4d0c1e-0000-4000-8000-000000000001",
    })
  })

  it("removes an enterprise attribute by its URN path", () => {
    const out = patched(user(), {
      op: "Remove",
      path: `${SCHEMA.enterprise}:department`,
    })
    expect(out.resource[SCHEMA.enterprise]).not.toHaveProperty("department")
  })
})

describe("PATCH: Okta's dialect", () => {
  it("deactivates with a path-less { active: false }", () => {
    const out = patched(readUser(OKTA_USER), {
      op: "replace",
      value: { active: false },
    })
    expect(out.active).toBe(false)
  })

  it("accepts the resource's own id inside a path-less value", () => {
    const out = patchUser(
      readUser(OKTA_USER).resource,
      ops({ op: "replace", value: { id: ID, displayName: "Admiral Hopper" } }),
      ID,
    )
    expect(out.displayName).toBe("Admiral Hopper")
  })

  it("adds an extension by URN object, attribute by attribute", () => {
    const out = patched(readUser(OKTA_USER), {
      op: "add",
      value: { [SCHEMA.enterprise]: { department: "Navy", costCenter: "C-1" } },
    })
    expect(out.resource[SCHEMA.enterprise]).toEqual({
      department: "Navy",
      costCenter: "C-1",
    })
  })
})

describe("PATCH: Google's shape", () => {
  it("replaces name parts and the userName with lowercase ops", () => {
    const out = patched(readUser(GOOGLE_USER), {
      op: "replace",
      path: "name.familyName",
      value: "Turing-Smith",
    })
    expect(out.familyName).toBe("Turing-Smith")
  })
})

// ── Groups ──────────────────────────────────────────────────────────────────

describe("groups", () => {
  const A = "11111111-1111-4111-8111-111111111111"
  const B = "22222222-2222-4222-8222-222222222222"
  const C = "33333333-3333-4333-8333-333333333333"

  it("refuses a group without a displayName and a member without a value", () => {
    expect(refusal(() => readGroup({})).status).toBe(400)
    expect(refusal(() => readGroup({ displayName: " " })).status).toBe(400)
    expect(
      refusal(() => readGroup({ displayName: "G", members: [{ display: "x" }] }))
        .status,
    ).toBe(400)
    expect(
      refusal(() =>
        readGroup({
          displayName: "G",
          members: new Array(LIMITS.members + 1).fill({ value: "x" }),
        }),
      ).status,
    ).toBe(400)
  })

  it("reads a group, deduplicating members, and keeps members out of the stored resource", () => {
    const g = readGroup({
      schemas: [SCHEMA.group],
      displayName: "Engineers",
      externalId: "g-1",
      members: [{ value: A }, { value: B, display: "B" }, { value: A }],
    })
    expect(g).toMatchObject({
      displayName: "Engineers",
      externalId: "g-1",
      members: [A, B],
    })
    expect(g.resource).not.toHaveProperty("members")
  })

  it("Okta adds and removes members by path", () => {
    const g = readGroup({ displayName: "G", members: [{ value: A }] })
    const added = patchGroup(
      g.resource,
      g.members,
      ops({
        op: "add",
        path: "members",
        value: [{ value: B, display: "B" }, { value: A }],
      }),
      ID,
    )
    expect(added.members).toEqual([A, B])
    const removed = patchGroup(
      added.resource,
      added.members,
      ops({ op: "remove", path: `members[value eq "${A}"]` }),
      ID,
    )
    expect(removed.members).toEqual([B])
    // Okta retries removals: removing somebody already gone is not an error.
    expect(() =>
      patchGroup(
        removed.resource,
        removed.members,
        ops({ op: "remove", path: `members[value eq "${A}"]` }),
        ID,
      ),
    ).not.toThrow()
  })

  it("Entra removes members with a value list, and replaces the whole list", () => {
    const g = readGroup({
      displayName: "G",
      members: [{ value: A }, { value: B }, { value: C }],
    })
    const removed = patchGroup(
      g.resource,
      g.members,
      ops({ op: "Remove", path: "members", value: [{ value: B }] }),
      ID,
    )
    expect(removed.members).toEqual([A, C])
    const replaced = patchGroup(
      g.resource,
      g.members,
      ops({ op: "Replace", path: "members", value: [{ value: C }] }),
      ID,
    )
    expect(replaced.members).toEqual([C])
    const cleared = patchGroup(
      g.resource,
      g.members,
      ops({ op: "Remove", path: "members" }),
      ID,
    )
    expect(cleared.members).toEqual([])
  })

  it("renames a group by path-less value or by path", () => {
    const g = readGroup({ displayName: "G" })
    expect(
      patchGroup(
        g.resource,
        [],
        ops({ op: "replace", value: { displayName: "H" } }),
        ID,
      ).displayName,
    ).toBe("H")
    expect(
      patchGroup(
        g.resource,
        [],
        ops({ op: "Replace", path: "displayName", value: "I" }),
        ID,
      ).displayName,
    ).toBe("I")
    expect(
      refusal(() =>
        patchGroup(g.resource, [], ops({ op: "remove", path: "displayName" }), ID),
      ).status,
    ).toBe(400)
  })

  it("renders a group resource with its members and location", () => {
    const view = groupResource(
      {
        id: ID,
        displayName: "G",
        externalId: null,
        resource: {},
        createdAt: new Date("2026-10-01T00:00:00Z"),
        updatedAt: new Date("2026-10-02T00:00:00Z"),
      },
      [{ id: A, display: "Ada" }],
      "https://x.test/scim/v2/d",
    )
    expect(view).toMatchObject({
      schemas: [SCHEMA.group],
      id: ID,
      displayName: "G",
      members: [
        {
          value: A,
          display: "Ada",
          type: "User",
          $ref: `https://x.test/scim/v2/d/Users/${A}`,
        },
      ],
      meta: {
        resourceType: "Group",
        location: `https://x.test/scim/v2/d/Groups/${ID}`,
      },
    })
  })
})

// ── Views and discovery ─────────────────────────────────────────────────────

describe("views and discovery", () => {
  it("renders a User with its groups and extension schemas, never a password", () => {
    const stored = readUser({ ...ENTRA_USER, password: "x" })
    const view = userResource(
      {
        id: ID,
        userName: stored.userName,
        externalId: stored.externalId,
        active: stored.active,
        resource: stored.resource,
        createdAt: new Date("2026-10-01T00:00:00Z"),
        updatedAt: new Date("2026-10-02T00:00:00Z"),
      },
      [{ id: "g1", displayName: "Eng" }],
      "https://x.test/scim/v2/d",
    )
    expect(view.schemas).toEqual([SCHEMA.user, SCHEMA.enterprise])
    expect(view).toMatchObject({
      id: ID,
      userName: "Ada.Lovelace@acme.test",
      active: true,
      groups: [
        { value: "g1", display: "Eng", $ref: "https://x.test/scim/v2/d/Groups/g1" },
      ],
      meta: { resourceType: "User", location: `https://x.test/scim/v2/d/Users/${ID}` },
    })
    expect(JSON.stringify(view)).not.toContain("password")
  })

  it("advertises what it does: patch and filter yes, bulk, sort, etag and password change no", () => {
    const config = serviceProviderConfig("https://x.test/scim/v2/d")
    expect(config).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: LIMITS.maxCount },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
    })
    expect(config.authenticationSchemes[0]?.type).toBe("oauthbearertoken")
  })

  it("describes User and Group, and the three schemas", () => {
    expect(resourceTypes("b").map((t) => t.id)).toEqual(["User", "Group"])
    expect(schemas("b").map((s) => s.id)).toEqual([
      SCHEMA.user,
      SCHEMA.group,
      SCHEMA.enterprise,
    ])
  })

  it("shapes an error as RFC 7644 3.12", () => {
    expect(errorBody(new ScimError(409, "taken", "uniqueness"))).toEqual({
      schemas: [SCHEMA.error],
      status: "409",
      scimType: "uniqueness",
      detail: "taken",
    })
    expect(errorBody(new ScimError(404, "gone"))).toEqual({
      schemas: [SCHEMA.error],
      status: "404",
      detail: "gone",
    })
  })
})

// ── Tokens ──────────────────────────────────────────────────────────────────

describe("bearer tokens", () => {
  const good = `${TOKEN_PREFIX}${"a".repeat(43)}`

  it("accepts only our format, in a Bearer header", () => {
    expect(readToken(`Bearer ${good}`)).toBe(good)
    expect(readToken(`bearer ${good}`)).toBe(good)
    expect(readToken(`Bearer   ${good}  `)).toBe(good)
  })

  it("refuses everything else: missing, other schemes, wrong prefix, wrong length, odd characters, oversized", () => {
    expect(readToken(undefined)).toBeNull()
    expect(readToken("")).toBeNull()
    expect(readToken(good)).toBeNull()
    expect(readToken(`Basic ${good}`)).toBeNull()
    expect(readToken(`Bearer sk_live_${"a".repeat(43)}`)).toBeNull()
    expect(readToken(`Bearer ${TOKEN_PREFIX}${"a".repeat(42)}`)).toBeNull()
    expect(readToken(`Bearer ${TOKEN_PREFIX}${"a".repeat(44)}`)).toBeNull()
    expect(readToken(`Bearer ${TOKEN_PREFIX}${"a".repeat(42)}!`)).toBeNull()
    expect(readToken(`Bearer ${good} extra`)).toBeNull()
    expect(readToken(`Bearer ${"a".repeat(200)}`)).toBeNull()
  })
})
