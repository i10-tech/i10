import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { Role, RoleStore } from "../src/console/roles.js"
import type { Connection } from "../src/identity/model.js"
import { storageAllocations } from "../src/mailboxes/allocation.js"
import {
  MAILBOX_STATUSES,
  consoleMailboxes,
  deriveMailboxStatus,
  managedMailLane,
  type ConsoleMailboxStore,
  type MailboxStatusInput,
  type PassthroughIdentityStore,
  type StoredConsoleMailboxRow,
} from "../src/mailboxes/console.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import { mountMailboxStorage } from "../src/routes/console/mailbox-storage.js"
import { mountMailboxes } from "../src/routes/console/mailboxes.js"
import { ACME, GIB, GLOBEX, memoryStore, PRO, row } from "./mailbox-quota-fixtures.js"

const OWNER = "user_owner"
const ADMIN = "user_admin"
const MEMBER = "user_member"
const OTHER_MEMBER = "user_other"
const RIVAL_USER = "user_rival"
const ORG = "org_acme"

const baseStatusInput = (
  overrides: Partial<MailboxStatusInput> = {},
): MailboxStatusInput => ({
  deleting: false,
  suspended: false,
  paymentHold: false,
  domainOff: false,
  banned: false,
  locked: false,
  signIn: "password",
  ssoRequired: false,
  ssoExempt: false,
  active: true,
  ...overrides,
})

describe("deriveMailboxStatus (one test per branch, first match wins)", () => {
  it("lists all nine statuses in priority order", () => {
    expect(MAILBOX_STATUSES).toEqual([
      "deleting",
      "suspended",
      "payment_hold",
      "domain_off",
      "banned",
      "locked",
      "sso_required",
      "inactive",
      "active",
    ])
  })

  it("branch 1: returns deleting when deleting is true, ahead of every other flag", () => {
    expect(
      deriveMailboxStatus(
        baseStatusInput({
          deleting: true,
          suspended: true,
          paymentHold: true,
          domainOff: true,
          banned: true,
          locked: true,
          signIn: "off",
          active: false,
        }),
      ),
    ).toBe("deleting")
  })

  it("branch 2: returns suspended when suspended is true, matching handleBind before refusedByRow", () => {
    expect(
      deriveMailboxStatus(
        baseStatusInput({
          suspended: true,
          paymentHold: true,
          domainOff: true,
          banned: true,
          locked: true,
          signIn: "off",
          active: false,
        }),
      ),
    ).toBe("suspended")
  })

  it("branch 3: returns payment_hold when paymentHold is true (refusedByRow case 1)", () => {
    expect(
      deriveMailboxStatus(
        baseStatusInput({
          paymentHold: true,
          domainOff: true,
          banned: true,
          locked: true,
          signIn: "off",
          active: false,
        }),
      ),
    ).toBe("payment_hold")
  })

  it("branch 4: returns domain_off when domainOff is true (refusedByRow case 2)", () => {
    expect(
      deriveMailboxStatus(
        baseStatusInput({
          domainOff: true,
          banned: true,
          locked: true,
          signIn: "off",
          active: false,
        }),
      ),
    ).toBe("domain_off")
  })

  it("branch 5: returns banned when banned is true (refusedByRow case 3)", () => {
    expect(
      deriveMailboxStatus(
        baseStatusInput({
          banned: true,
          locked: true,
          signIn: "off",
          active: false,
        }),
      ),
    ).toBe("banned")
  })

  it("branch 6: returns locked when locked is true (refusedByRow case 4)", () => {
    expect(
      deriveMailboxStatus(
        baseStatusInput({
          locked: true,
          signIn: "off",
          active: false,
        }),
      ),
    ).toBe("locked")
  })

  it("branch 7: returns sso_required when managed with lane off, or unmanaged on a required domain without exemption", () => {
    expect(
      deriveMailboxStatus(
        baseStatusInput({
          signIn: "off",
          active: false,
        }),
      ),
    ).toBe("sso_required")

    expect(
      deriveMailboxStatus(
        baseStatusInput({
          signIn: "password",
          ssoRequired: true,
          ssoExempt: false,
          active: true,
        }),
      ),
    ).toBe("sso_required")

    // Exempt owner/admin on a required domain is not refused by sso_required.
    expect(
      deriveMailboxStatus(
        baseStatusInput({
          signIn: "password",
          ssoRequired: true,
          ssoExempt: true,
          active: true,
        }),
      ),
    ).toBe("active")
  })

  it("branch 8: returns inactive when active is false (created in Clerk but no mailbox yet)", () => {
    expect(
      deriveMailboxStatus(
        baseStatusInput({
          active: false,
        }),
      ),
    ).toBe("inactive")
  })

  it("branch 9: returns active when active is true and nothing refuses sign-in", () => {
    expect(deriveMailboxStatus(baseStatusInput())).toBe("active")
    expect(deriveMailboxStatus(baseStatusInput({ signIn: "oidc" }))).toBe("active")
    expect(deriveMailboxStatus(baseStatusInput({ signIn: "ldap" }))).toBe("active")
  })
})

describe("managedMailLane", () => {
  const fakeConnection = (
    over: Partial<Connection>,
    secrets: Record<string, unknown> = {},
    domains: string[] = ["acme.test"],
  ): PassthroughIdentityStore => ({
    connectionForStart: async (id) => ({
      id,
      tenantId: ACME,
      name: "IdP",
      protocol: "oidc",
      provider: "okta",
      status: "active",
      enforcement: "optional",
      jitEnabled: true,
      mfaRequired: false,
      maxSessionSeconds: null,
      idleTimeoutSeconds: null,
      config: {
        oidcMail: {
          preset: "okta",
          issuer: "https://acme.okta.com/oauth2/default",
          tokenEndpoint: "https://acme.okta.com/oauth2/default/v1/token",
          clientId: "0oa1b2c3d4e5f6g7h8i9",
          extra: {},
          enabled: true,
        },
      },
      attributeMapping: {},
      relink: "ask",
      upnAsEmail: false,
      ...over,
    }),
    connectionSecrets: async () => secrets,
    liveDomains: async () => domains,
  })

  it("returns password for an unmanaged (Clerk) account", async () => {
    expect(await managedMailLane(undefined, null, false)).toBe("password")
  })

  it("returns oidc for a managed account whose active OIDC connection enables mail pass-through", async () => {
    expect(await managedMailLane(fakeConnection({}), "conn_oidc", true)).toBe("oidc")
  })

  it("returns ldap for a managed account whose active connection enables LDAP pass-through", async () => {
    const store = fakeConnection(
      {
        protocol: "saml",
        config: {
          ldap: {
            enabled: true,
            host: "ldap.acme.test",
            port: 636,
            tlsMode: "ldaps",
            caPem: null,
            searchBase: "dc=acme,dc=test",
            userFilter: "(mail={email})",
          },
        },
      },
      {
        ldap: {
          bindDn: "cn=svc,dc=acme,dc=test",
          bindSecret: "topsecret",
        },
      },
    )
    expect(await managedMailLane(store, "conn_ldap", true)).toBe("ldap")
  })

  it("returns off for a managed account when pass-through is off or the connection is missing", async () => {
    const disabled = fakeConnection({ status: "disabled" })
    expect(await managedMailLane(disabled, "conn_disabled", true)).toBe("off")
    expect(await managedMailLane(undefined, "conn_any", true)).toBe("off")
    expect(await managedMailLane(fakeConnection({}), null, true)).toBe("off")
  })
})

function makeMailboxRow(
  overrides: Partial<StoredConsoleMailboxRow> & {
    clerkUserId: string
    address: string
  },
): StoredConsoleMailboxRow {
  return {
    displayName: null,
    ownerName: null,
    ownerEmail: overrides.address,
    active: true,
    suspended: false,
    paymentHold: false,
    domainOff: false,
    banned: false,
    locked: false,
    managed: false,
    connectionId: null,
    ssoRequired: false,
    ssoExempt: false,
    allocatedBytes: null,
    usedBytes: null,
    usedAt: null,
    aliases: [],
    createdAt: new Date("2026-11-01T10:00:00.000Z"),
    updatedAt: new Date("2026-11-02T10:00:00.000Z"),
    ...overrides,
  }
}

function buildWorld() {
  const byTenant: Record<string, StoredConsoleMailboxRow[]> = {
    [ACME]: [
      makeMailboxRow({
        clerkUserId: OWNER,
        address: "owner@acme.test",
        displayName: "Ada Lovelace",
        ownerName: "Ada Lovelace",
        ownerEmail: "owner@acme.test",
        allocatedBytes: 4 * GIB,
        usedBytes: 1_048_576,
        usedAt: new Date("2026-11-10T12:00:00.000Z"),
        aliases: [
          { address: "ada@acme.test", source: "clerk" },
          { address: "ceo@acme.test", source: "directory" },
        ],
        createdAt: new Date("2026-11-03T10:00:00.000Z"),
        updatedAt: new Date("2026-11-04T10:00:00.000Z"),
      }),
      makeMailboxRow({
        clerkUserId: MEMBER,
        address: "sam@acme.test",
        displayName: "Sam Member",
        ownerName: "Sam Member",
        ownerEmail: "sam@acme.test",
        allocatedBytes: 2 * GIB,
        usedBytes: null,
        usedAt: null,
        createdAt: new Date("2026-11-02T10:00:00.000Z"),
        updatedAt: new Date("2026-11-02T12:00:00.000Z"),
      }),
      makeMailboxRow({
        clerkUserId: OTHER_MEMBER,
        address: "kim@acme.test",
        displayName: "Kim Managed",
        ownerName: "Kim Managed",
        ownerEmail: "kim@acme.test",
        managed: true,
        connectionId: "conn_off",
        createdAt: new Date("2026-11-01T10:00:00.000Z"),
        updatedAt: new Date("2026-11-01T12:00:00.000Z"),
      }),
    ],
    [GLOBEX]: [
      makeMailboxRow({
        clerkUserId: RIVAL_USER,
        address: "pat@globex.test",
        displayName: "Pat Rival",
        ownerName: "Pat Rival",
        ownerEmail: "pat@globex.test",
        allocatedBytes: GIB,
      }),
    ],
  }

  const store: ConsoleMailboxStore = {
    async list({ tenantId, onlyUserId, limit, cursor }) {
      let rows = [...(byTenant[tenantId] ?? [])]
      if (onlyUserId) {
        rows = rows.filter((r) => r.clerkUserId === onlyUserId)
      }
      rows.sort((a, b) => {
        const dt = b.createdAt.getTime() - a.createdAt.getTime()
        return dt !== 0 ? dt : b.address.localeCompare(a.address)
      })
      if (cursor) {
        const cursorTime = new Date(cursor.createdAt).getTime()
        rows = rows.filter((r) => {
          const t = r.createdAt.getTime()
          return (
            t < cursorTime ||
            (t === cursorTime && r.address < cursor.address.toLowerCase())
          )
        })
      }
      return rows.slice(0, limit)
    },
    async get({ tenantId, address, onlyUserId }) {
      const wanted = address.trim().toLowerCase()
      const found = (byTenant[tenantId] ?? []).find(
        (r) =>
          r.address.toLowerCase() === wanted &&
          (!onlyUserId || r.clerkUserId === onlyUserId),
      )
      return found ?? null
    },
  }

  const rolesByUser: Record<string, Role> = {
    [OWNER]: "owner",
    [ADMIN]: "admin",
    [MEMBER]: "member",
    [OTHER_MEMBER]: "member",
  }

  const roleStore: Pick<RoleStore, "roleOf"> = {
    roleOf: async (_tenantId, userId) => rolesByUser[userId] ?? null,
  }

  const mailboxStorage = storageAllocations({
    store: memoryStore(
      {
        [ACME]: [
          row("owner@acme.test", 4 * GIB),
          row("sam@acme.test", 2 * GIB),
          row("kim@acme.test", null),
        ],
      },
      { [ACME]: 1_048_576 },
    ),
    assignments: { find: async () => PRO },
  })

  const mailboxes = consoleMailboxes({
    store,
    roles: roleStore,
    pool: async (tenantId) => (await mailboxStorage.overview(tenantId)).pool,
  })

  return { byTenant, store, roleStore, mailboxStorage, mailboxes }
}

function appFor(
  w: ReturnType<typeof buildWorld>,
  userId: string,
  opts: { tenantId?: string; orgId?: string | undefined; unwired?: boolean } = {},
) {
  const app = new Hono()
  const tenantId = opts.tenantId ?? ACME
  app.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId, scopes: [], mode: "live" })
    c.set("user", { userId, orgId: "orgId" in opts ? opts.orgId : ORG })
    await next()
  })
  const deps = (opts.unwired
    ? {}
    : {
        roles: { store: w.roleStore },
        teamDomains: {
          can: async (tId: string, uId: string, perm: string) =>
            perm === "members:manage" &&
            (uId === OWNER || uId === ADMIN) &&
            tId === ACME,
        },
        mailboxStorage: w.mailboxStorage,
        mailboxes: w.mailboxes,
      }) as unknown as ConsoleDeps

  mountMailboxStorage(app, deps)
  mountMailboxes(app, deps)
  return app
}

describe("GET /console/mailboxes and GET /console/mailboxes/:address", () => {
  it("lets owners and admins see every mailbox in the workspace along with the storage pool summary", async () => {
    const w = buildWorld()

    for (const caller of [OWNER, ADMIN]) {
      const res = await appFor(w, caller).request("/mailboxes")
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: Record<string, unknown>[]
        pool: Record<string, unknown>
        nextCursor: string | null
      }

      expect(body.nextCursor).toBeNull()
      expect(body.pool).toEqual({
        kind: "pool",
        total: 10 * GIB,
        allocated: 6 * GIB,
        used: 1_048_576,
        remaining: 4 * GIB,
        unallocated: 1,
      })
      expect(body.data.map((m) => m.address)).toEqual([
        "owner@acme.test",
        "sam@acme.test",
        "kim@acme.test",
      ])
      expect(body.data[0]).toEqual({
        address: "owner@acme.test",
        displayName: "Ada Lovelace",
        owner: {
          userId: OWNER,
          clerkUserId: OWNER,
          name: "Ada Lovelace",
          email: "owner@acme.test",
        },
        domain: "acme.test",
        status: "active",
        signIn: "password",
        aliases: [
          { address: "ada@acme.test", source: "clerk" },
          { address: "ceo@acme.test", source: "directory" },
        ],
        storage: {
          allocatedBytes: 4 * GIB,
          usedBytes: 1_048_576,
          usedAt: "2026-11-10T12:00:00.000Z",
        },
        createdAt: "2026-11-03T10:00:00.000Z",
        updatedAt: "2026-11-04T10:00:00.000Z",
      })
      // Unsampled mailbox reports usedBytes: null, never 0.
      expect(body.data[1]?.storage).toEqual({
        allocatedBytes: 2 * GIB,
        usedBytes: null,
        usedAt: null,
      })
      // Managed account with lane off reports signIn: "off" and status: "sso_required".
      expect(body.data[2]).toMatchObject({
        address: "kim@acme.test",
        signIn: "off",
        status: "sso_required",
      })
    }
  })

  it("shows a member only their own mailbox in GET /console/mailboxes", async () => {
    const w = buildWorld()
    const res = await appFor(w, MEMBER).request("/mailboxes")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { address: string }[] }
    expect(body.data.map((m) => m.address)).toEqual(["sam@acme.test"])
  })

  it("returns 200 when a member fetches their own mailbox and 404 (never 403) when asking for someone else's", async () => {
    const w = buildWorld()
    const app = appFor(w, MEMBER)

    const own = await app.request("/mailboxes/sam%40acme.test")
    expect(own.status).toBe(200)
    expect(((await own.json()) as { address: string }).address).toBe("sam@acme.test")

    const other = await app.request("/mailboxes/owner%40acme.test")
    expect(other.status).toBe(404)
    expect(await other.json()).toEqual({
      statusCode: 404,
      name: "not_found",
      message: "No such mailbox in this workspace.",
    })
  })

  it("lets an admin fetch any mailbox in the workspace and returns 404 for another workspace's mailbox", async () => {
    const w = buildWorld()
    const app = appFor(w, ADMIN)

    const memberBox = await app.request("/mailboxes/sam%40acme.test")
    expect(memberBox.status).toBe(200)
    expect(((await memberBox.json()) as { address: string }).address).toBe(
      "sam@acme.test",
    )

    const rivalBox = await app.request("/mailboxes/pat%40globex.test")
    expect(rivalBox.status).toBe(404)
  })

  it("paginates with cursor and limit", async () => {
    const w = buildWorld()
    const app = appFor(w, OWNER)

    const page1Res = await app.request("/mailboxes?limit=2")
    expect(page1Res.status).toBe(200)
    const page1 = (await page1Res.json()) as {
      data: { address: string }[]
      nextCursor: string | null
    }
    expect(page1.data.map((m) => m.address)).toEqual([
      "owner@acme.test",
      "sam@acme.test",
    ])
    expect(page1.nextCursor).toEqual(expect.any(String))

    const page2Res = await app.request(
      `/mailboxes?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    )
    expect(page2Res.status).toBe(200)
    const page2 = (await page2Res.json()) as {
      data: { address: string }[]
      nextCursor: string | null
    }
    expect(page2.data.map((m) => m.address)).toEqual(["kim@acme.test"])
    expect(page2.nextCursor).toBeNull()
  })

  it("does not shadow GET /mailboxes/storage with GET /mailboxes/:address", async () => {
    const w = buildWorld()
    const res = await appFor(w, ADMIN).request("/mailboxes/storage")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { pool: unknown; data: unknown[] }
    expect(body.pool).toBeDefined()
    expect(body.data).toHaveLength(3)
  })

  it("returns 404 on malformed address parameters and 501 when unwired", async () => {
    const w = buildWorld()
    const app = appFor(w, ADMIN)

    expect((await app.request("/mailboxes/not-an-address")).status).toBe(404)
    expect((await app.request("/mailboxes/%E0%A4%A")).status).toBe(404)

    const unwired = appFor(w, ADMIN, { unwired: true })
    expect((await unwired.request("/mailboxes")).status).toBe(501)
    expect((await unwired.request("/mailboxes/sam%40acme.test")).status).toBe(501)
  })
})
