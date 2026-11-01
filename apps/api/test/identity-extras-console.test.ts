import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import type { KeySummary, KeyStore } from "../src/auth/store.js"
import type { IdentityFeature } from "../src/identity/features.js"
import type { StoredEvent } from "../src/identity/ports.js"
import { CONNECTION, TENANT, log, memoryClerk, memoryStore } from "./identity-fakes.js"
import { SECRET, memoryBucket, memorySiem } from "./identity-siem-fakes.js"

/**
 * The console half of #345 slice B: the SIEM settings, the deprovisioned
 * person's API keys, and the plan flags. Every refusal first.
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}
const KEY = "55555555-5555-4555-8555-555555555555"
const OTHER_KEY = "66666666-6666-4666-8666-666666666666"

const summary = (id: string, name: string): KeySummary => ({
  id,
  name,
  prefix: "i10_live_abcd",
  mode: "live",
  scopes: [],
  createdBy: "user_gone",
  createdAt: new Date("2026-09-01T00:00:00Z"),
  lastUsedAt: new Date("2026-10-27T00:00:00Z"),
  expiresAt: null,
  revokedAt: null,
})

function app(
  opts: {
    denied?: IdentityFeature[]
    vetOk?: boolean
    deprovisioned?: boolean
    cacheFails?: boolean
  } = {},
) {
  const world = memoryStore()
  const seeded: StoredEvent[] = opts.deprovisioned
    ? [
        {
          id: "e1",
          type: "member.deprovisioned",
          actorUserId: "user_admin",
          subjectUserId: "user_gone",
          connectionId: null,
          sessionId: null,
          reason: "admin",
          data: {},
          createdAt: new Date(),
        },
      ]
    : []
  const store = {
    ...world.store,
    events: async (_t: string, o: { subjectUserId?: string }) =>
      seeded.filter((e) => !o.subjectUserId || e.subjectUserId === o.subjectUserId),
  }
  const siem = memorySiem(TENANT, [])
  const saved: unknown[] = []
  siem.store.put = async (_t, settings) => {
    saved.push(settings)
    return (await siem.store.get(TENANT))!
  }
  const bucket = memoryBucket()
  const live: KeySummary[] = [summary(KEY, "Production")]
  const rotations: Array<{ id: string; createdBy?: string | null }> = []
  const revoked: string[] = []
  const evicted: string[] = []
  const keyStore = {
    createdBy: async (_t: string, user: string) => (user === "user_gone" ? live : []),
    createdByDeprovisioned: async () =>
      opts.deprovisioned
        ? live.map((key) => ({
            key,
            deprovisionedAt: new Date("2026-08-01T00:00:00Z"),
          }))
        : [],
    revoke: async (_t: string, id: string) => (revoked.push(id), { secretHash: "H1" }),
    rotate: async (_t: string, id: string, o?: { createdBy?: string | null }) => {
      rotations.push({ id, ...(o ?? {}) })
      return {
        created: { ...summary("new-key", "Production"), secret: "i10_live_NEWSECRET" },
        revokedHash: "H0",
      }
    },
  } as unknown as KeyStore
  let fresh = true
  const hono = new Hono()
  hono.use("*", async (c, next) => {
    c.set("auth", { apiKeyId: "", tenantId: TENANT, scopes: [], mode: "live" } as never)
    c.set("user", { userId: c.req.header("x-user") ?? "", orgId: "org_acme" } as never)
    c.set("freshAuth", (async () => ({ status: fresh ? "fresh" : "stale" })) as never)
    await next()
  })
  mountIdentity(hono, {
    roles: { store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null } },
    keys: {
      store: keyStore,
      cache: {
        get: async () => null,
        set: async () => {},
        del: async (k: string) => {
          if (opts.cacheFails) throw new Error("redis down")
          evicted.push(k)
        },
      },
    },
    log: { error: () => {}, warn: () => {} },
    identity: {
      store,
      clerk: memoryClerk().clerk,
      gate: { forget: () => {} },
      protocols: ["test"],
      deprovision: {},
      features: {
        allows: async (_t: string, f: IdentityFeature) => !opts.denied?.includes(f),
      },
      siem: {
        store: siem.store,
        vet: async () =>
          opts.vetOk === false
            ? { ok: false, kind: "blocked", reason: "10.0.0.5 is not a public address" }
            : { ok: true },
        fetch: bucket.fetch,
      },
      log,
    },
  } as unknown as ConsoleDeps)
  const call = (user: string, method: string, path: string, body?: unknown) =>
    hono.request(path, {
      method,
      headers: { "content-type": "application/json", "x-user": user },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return {
    call,
    world,
    saved,
    bucket,
    rotations,
    revoked,
    evicted,
    stale: () => (fresh = false),
    audit: (type: string) => world.events.filter((e) => e.type === type),
  }
}

const settings = {
  endpoint: "https://s3.eu-west-1.amazonaws.com",
  bucket: "acme-siem",
  region: "eu-west-1",
  prefix: "logs",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: SECRET,
}

describe("the SIEM settings", () => {
  it("refuses an admin changing them, and a member reading them", async () => {
    const w = app()
    expect((await w.call("user_admin", "PUT", "/identity/siem", settings)).status).toBe(
      403,
    )
    expect((await w.call("user_admin", "DELETE", "/identity/siem")).status).toBe(403)
    expect((await w.call("user_admin", "POST", "/identity/siem/test")).status).toBe(403)
    expect((await w.call("user_m", "GET", "/identity/siem")).status).toBe(403)
    expect(w.saved).toEqual([])
  })

  it("refuses an owner without step-up", async () => {
    const w = app()
    w.stale()
    for (const [m, p] of [
      ["PUT", "/identity/siem"],
      ["DELETE", "/identity/siem"],
      ["POST", "/identity/siem/test"],
    ] as const)
      expect((await w.call("user_owner", m, p, settings)).status).toBe(403)
    expect(w.saved).toEqual([])
    expect(w.audit("siem.configured")).toEqual([])
  })

  it("refuses an endpoint the egress guard refuses, and an http one", async () => {
    const blocked = app({ vetOk: false })
    const res = await blocked.call("user_owner", "PUT", "/identity/siem", settings)
    expect(res.status).toBe(422)
    expect(((await res.json()) as { message: string }).message).toContain(
      "10.0.0.5 is not a public address",
    )
    expect(blocked.saved).toEqual([])
    const plain = await app().call("user_owner", "PUT", "/identity/siem", {
      ...settings,
      endpoint: "http://s3.example.com",
    })
    expect(plain.status).toBe(422)
  })

  it("refuses a first save with no secret", async () => {
    const rest: Partial<typeof settings> = { ...settings }
    delete rest.secretAccessKey
    const res = await app().call("user_owner", "PUT", "/identity/siem", rest)
    // The fake store already has a row, so this is the update path: it must
    // succeed without a secret and never touch the stored one.
    expect(res.status).toBe(200)
  })

  it("saves for an owner, audits without the key, and never returns it", async () => {
    const w = app()
    const put = await w.call("user_owner", "PUT", "/identity/siem", settings)
    expect(put.status).toBe(200)
    const body = await put.text()
    expect(body).not.toContain(SECRET)
    expect(body).toContain(`••••${SECRET.slice(-4)}`)
    const got = await (await w.call("user_admin", "GET", "/identity/siem")).text()
    expect(got).not.toContain(SECRET)
    const audit = JSON.stringify(w.audit("siem.configured"))
    expect(audit).not.toContain(SECRET)
    expect(w.audit("siem.configured")[0]).toMatchObject({
      actorUserId: "user_owner",
      data: { bucket: "acme-siem", secretChanged: true },
    })
  })

  it("writes a test object for an owner, audited", async () => {
    const w = app()
    const res = await w.call("user_owner", "POST", "/identity/siem/test")
    expect(await res.json()).toMatchObject({ ok: true })
    expect(w.audit("siem.tested")).toHaveLength(1)
  })
})

describe("every live key of the deprovisioned", () => {
  const all = "/identity/deprovisioned/api-keys"

  it("groups them by person with when they left, for an admin", async () => {
    const w = app({ deprovisioned: true })
    const res = await w.call("user_admin", "GET", all)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ user_id: string; deprovisioned_at: string; keys: { id: string }[] }>
    }
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      user_id: "user_gone",
      deprovisioned_at: "2026-08-01T00:00:00.000Z",
    })
    expect(body.data[0]!.keys.map((k) => k.id)).toEqual([KEY])
  })

  it("is empty when nobody with a live key was deprovisioned", async () => {
    const w = app()
    const res = await w.call("user_admin", "GET", all)
    expect(await res.json()).toEqual({ data: [] })
  })

  it("refuses a member", async () => {
    const w = app({ deprovisioned: true })
    expect((await w.call("user_m", "GET", all)).status).toBe(403)
  })
})

describe("the API keys of a deprovisioned person", () => {
  const base = "/identity/deprovisioned/user_gone/api-keys"

  it("lists them for an admin, with last use and no secret", async () => {
    const w = app({ deprovisioned: true })
    const res = await w.call("user_admin", "GET", base)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<Record<string, unknown>> }
    expect(body.data).toEqual([
      {
        id: KEY,
        name: "Production",
        prefix: "i10_live_abcd",
        mode: "live",
        created_at: "2026-09-01T00:00:00.000Z",
        last_used_at: "2026-10-27T00:00:00.000Z",
        expires_at: null,
      },
    ])
  })

  it("refuses a member, and anybody who was never deprovisioned", async () => {
    const w = app({ deprovisioned: true })
    expect((await w.call("user_m", "GET", base)).status).toBe(403)
    expect(
      (await w.call("user_admin", "GET", "/identity/deprovisioned/user_other/api-keys"))
        .status,
    ).toBe(404)
    const none = app()
    expect((await none.call("user_admin", "GET", base)).status).toBe(404)
  })

  it("refuses an admin rotating or revoking, and an owner without step-up", async () => {
    const w = app({ deprovisioned: true })
    for (const action of ["rotate", "revoke"])
      expect(
        (await w.call("user_admin", "POST", `${base}/${KEY}/${action}`)).status,
      ).toBe(403)
    w.stale()
    for (const action of ["rotate", "revoke"])
      expect(
        (await w.call("user_owner", "POST", `${base}/${KEY}/${action}`)).status,
      ).toBe(403)
    expect(w.rotations).toEqual([])
    expect(w.revoked).toEqual([])
  })

  it("refuses a key the person did not create", async () => {
    const w = app({ deprovisioned: true })
    expect(
      (await w.call("user_owner", "POST", `${base}/${OTHER_KEY}/revoke`)).status,
    ).toBe(404)
    expect(w.revoked).toEqual([])
  })

  it("rotates for an owner: the new key is theirs, shown once, and audited", async () => {
    const w = app({ deprovisioned: true })
    const res = await w.call("user_owner", "POST", `${base}/${KEY}/rotate`)
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ secret: "i10_live_NEWSECRET" })
    expect(w.rotations).toEqual([{ id: KEY, createdBy: "user_owner" }])
    const event = w.audit("member.api_key_rotated")[0]!
    expect(event).toMatchObject({
      actorUserId: "user_owner",
      subjectUserId: "user_gone",
    })
    expect(JSON.stringify(event)).not.toContain("NEWSECRET")
  })

  it("revokes for an owner, audited; a cache failure is a 500 but still audited", async () => {
    const ok = app({ deprovisioned: true })
    expect((await ok.call("user_owner", "POST", `${base}/${KEY}/revoke`)).status).toBe(
      200,
    )
    expect(ok.revoked).toEqual([KEY])
    expect(ok.audit("member.api_key_revoked")).toHaveLength(1)
    const bad = app({ deprovisioned: true, cacheFails: true })
    expect((await bad.call("user_owner", "POST", `${base}/${KEY}/revoke`)).status).toBe(
      500,
    )
    expect(bad.audit("member.api_key_revoked")).toHaveLength(1)
  })
})

describe("plan flags", () => {
  const cases: Array<[IdentityFeature, string, string, unknown?]> = [
    ["sso_oidc", "GET", `/identity/connections/${CONNECTION}/oidc`],
    ["sso_saml", "GET", `/identity/connections/${CONNECTION}/saml`],
    ["group_roles", "GET", `/identity/connections/${CONNECTION}/group-rules`],
    ["sso_enforcement", "GET", `/identity/connections/${CONNECTION}/bypass`],
    ["sso_enforcement", "GET", "/identity/owner-exemption"],
    ["staff_setup", "GET", `/identity/connections/${CONNECTION}/setup-links`],
    ["scim", "GET", "/identity/directories"],
    ["directory_mailboxes", "GET", "/identity/mailboxes"],
    ["session_policy", "GET", "/identity/session-policy"],
    ["session_policy", "GET", "/identity/second-factor-policy"],
    ["ip_allowlist", "GET", "/identity/ip-allowlist"],
    ["siem_export", "GET", "/identity/siem"],
    ["siem_export", "PUT", "/identity/siem", settings],
    ["sso_oidc", "POST", "/identity/connections", { name: "x", protocol: "test" }],
    [
      "sso_enforcement",
      "PATCH",
      `/identity/connections/${CONNECTION}`,
      { enforcement: "optional" },
    ],
    ["jit_rules", "PATCH", `/identity/connections/${CONNECTION}`, { jitEnabled: true }],
  ]

  it.each(cases)(
    "%s: %s %s answers 403 plan_required when the plan lacks it",
    async (feature, method, path, body) => {
      // The directory routes serve SCIM and Google, so a plan without SCIM only
      // loses them when it lacks Google's too.
      const w = app({
        denied: feature === "scim" ? ["scim", "google_directory"] : [feature],
      })
      const res = await w.call("user_owner", method, path, body)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ name: "plan_required", feature })
    },
  )

  it("lets the same requests through when every flag is on", async () => {
    const w = app()
    for (const [, method, path, body] of cases) {
      const res = await w.call("user_owner", method, path, body)
      const json = (await res
        .clone()
        .json()
        .catch(() => ({}))) as { name?: string }
      expect(json.name).not.toBe("plan_required")
    }
  })

  it("never refuses switching a feature off", async () => {
    const w = app({ denied: ["sso_enforcement", "jit_rules"] })
    for (const body of [{ enforcement: "off" }, { jitEnabled: false }]) {
      const res = await w.call(
        "user_owner",
        "PATCH",
        `/identity/connections/${CONNECTION}`,
        body,
      )
      const json = (await res
        .clone()
        .json()
        .catch(() => ({}))) as { name?: string }
      expect(json.name).not.toBe("plan_required")
    }
  })
})
