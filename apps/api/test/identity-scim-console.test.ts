import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mountIdentity } from "../src/routes/console/identity.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import type { Role } from "../src/console/roles.js"
import { MAX_DIRECTORIES } from "../src/routes/console/identity-scim.js"
import { TOKEN_PREFIX, readToken } from "../src/identity/scim.js"
import { hashSecret } from "../src/identity/model.js"
import { TENANT, log, memoryClerk, memoryStore } from "./identity-fakes.js"
import { DIRECTORY, memoryDirectories, scimToken } from "./identity-scim-fakes.js"

/**
 * The console's SCIM directory routes (#342): who may do what, step-up on
 * every write, the token shown once and never audited, and every change in the
 * audit log with its actor.
 */

const ROLES: Record<string, Role> = {
  user_owner: "owner",
  user_admin: "admin",
  user_m: "member",
}
const BASE = "https://api.test/scim/v2"
const MISSING = "99999999-9999-4999-8999-999999999999"

function consoleApp(options: { fresh?: boolean; wired?: boolean } = {}) {
  const identity = memoryStore()
  const dirs = memoryDirectories({
    directories: [{ id: DIRECTORY, name: "Okta" }],
    tokens: [],
  })
  let fresh = options.fresh ?? true
  const kicks: { directoryId: string; force: boolean }[] = []
  const scheduled: string[] = []
  const apps = new Map<string, Hono>()
  const as = (userId: string) => {
    const cached = apps.get(userId)
    if (cached) return cached
    const app = new Hono()
    app.use("*", async (c, next) => {
      c.set("auth", {
        apiKeyId: "",
        tenantId: TENANT,
        scopes: [],
        mode: "live",
      } as never)
      c.set("user", { userId, orgId: "org_acme" } as never)
      c.set("freshAuth", (async () =>
        fresh ? { status: "fresh" } : { status: "stale" }) as never)
      await next()
    })
    mountIdentity(app, {
      roles: { store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null } },
      identity: {
        store: identity.store,
        clerk: memoryClerk().clerk,
        gate: { forget: () => {} },
        protocols: ["test"],
        deprovision: {},
        ...(options.wired === false
          ? {}
          : {
              scim: {
                store: dirs.store,
                baseUrl: (id: string) => `${BASE}/${id}`,
                kick: async (
                  _t: string,
                  directoryId: string,
                  o?: { force?: boolean },
                ) => {
                  kicks.push({ directoryId, force: o?.force ?? false })
                },
                schedule: async (
                  _t: string,
                  entries: readonly { directoryUserId: string }[],
                ) => {
                  scheduled.push(...entries.map((e) => e.directoryUserId))
                },
              },
            }),
        log,
      },
    } as unknown as ConsoleDeps)
    apps.set(userId, app)
    return app
  }
  const call = (userId: string, method: string, path: string, body?: unknown) =>
    as(userId).request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const events = (type: string) => identity.events.filter((e) => e.type === type)
  return {
    identity,
    dirs,
    call,
    events,
    kicks,
    scheduled,
    setFresh: (value: boolean) => {
      fresh = value
    },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each test reads its own shape
const json = async (res: Response) => (await res.json()) as Record<string, any>

describe("directories: permissions", () => {
  it("answers 501 where SCIM is not wired", async () => {
    const w = consoleApp({ wired: false })
    for (const [method, path] of [
      ["GET", "/identity/directories"],
      ["POST", "/identity/directories"],
      ["GET", `/identity/directories/${DIRECTORY}`],
      ["PATCH", `/identity/directories/${DIRECTORY}`],
      ["POST", `/identity/directories/${DIRECTORY}/tokens`],
      ["DELETE", `/identity/directories/${DIRECTORY}/tokens/${MISSING}`],
      ["GET", `/identity/directories/${DIRECTORY}/conflicts`],
      ["POST", `/identity/directories/${DIRECTORY}/conflicts/${MISSING}/retry`],
    ] as const)
      expect((await w.call("user_owner", method, path, {})).status).toBe(501)
  })

  it("lets only an admin or an owner read directories", async () => {
    const w = consoleApp()
    expect((await w.call("user_m", "GET", "/identity/directories")).status).toBe(403)
    expect(
      (await w.call("user_m", "GET", `/identity/directories/${DIRECTORY}`)).status,
    ).toBe(403)
    expect(
      (await w.call("user_m", "GET", `/identity/directories/${DIRECTORY}/conflicts`))
        .status,
    ).toBe(403)
    expect((await w.call("user_admin", "GET", "/identity/directories")).status).toBe(
      200,
    )
    expect((await w.call("user_owner", "GET", "/identity/directories")).status).toBe(
      200,
    )
  })

  it("lets only an owner add a directory, issue a token, or enable one", async () => {
    const w = consoleApp()
    for (const who of ["user_admin", "user_m"]) {
      expect(
        (await w.call(who, "POST", "/identity/directories", { name: "Entra" })).status,
      ).toBe(403)
      expect(
        (await w.call(who, "POST", `/identity/directories/${DIRECTORY}/tokens`, {}))
          .status,
      ).toBe(403)
    }
    await w.call("user_admin", "PATCH", `/identity/directories/${DIRECTORY}`, {
      enabled: false,
    })
    expect(
      (
        await w.call("user_admin", "PATCH", `/identity/directories/${DIRECTORY}`, {
          enabled: true,
        })
      ).status,
    ).toBe(403)
    expect(w.dirs.directories.get(DIRECTORY)!.enabled).toBe(false)
    expect(
      (
        await w.call("user_owner", "PATCH", `/identity/directories/${DIRECTORY}`, {
          enabled: true,
        })
      ).status,
    ).toBe(200)
    expect(w.dirs.tokens).toEqual([])
    expect(w.events("directory.created")).toEqual([])
    expect(w.events("directory.token_issued")).toEqual([])
  })

  it("lets an admin disable, rename and revoke, and a member none of it", async () => {
    const w = consoleApp()
    const issued = await json(
      await w.call(
        "user_owner",
        "POST",
        `/identity/directories/${DIRECTORY}/tokens`,
        {},
      ),
    )
    expect(
      (
        await w.call("user_m", "PATCH", `/identity/directories/${DIRECTORY}`, {
          name: "x",
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await w.call(
          "user_m",
          "DELETE",
          `/identity/directories/${DIRECTORY}/tokens/${issued.id}`,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await w.call(
          "user_m",
          "POST",
          `/identity/directories/${DIRECTORY}/conflicts/${MISSING}/retry`,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await w.call("user_admin", "PATCH", `/identity/directories/${DIRECTORY}`, {
          name: "Renamed",
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await w.call("user_admin", "PATCH", `/identity/directories/${DIRECTORY}`, {
          enabled: false,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await w.call(
          "user_admin",
          "DELETE",
          `/identity/directories/${DIRECTORY}/tokens/${issued.id}`,
        )
      ).status,
    ).toBe(200)
  })

  it("needs a fresh step-up for every write, and reads without one", async () => {
    const w = consoleApp({ fresh: false })
    const writes = [
      ["POST", "/identity/directories", { name: "Entra" }],
      ["PATCH", `/identity/directories/${DIRECTORY}`, { name: "x" }],
      ["POST", `/identity/directories/${DIRECTORY}/tokens`, {}],
      ["DELETE", `/identity/directories/${DIRECTORY}/tokens/${MISSING}`, undefined],
    ] as const
    for (const [method, path, body] of writes)
      expect((await w.call("user_owner", method, path, body)).status).toBe(403)
    expect(w.dirs.tokens).toEqual([])
    expect(w.dirs.directories.size).toBe(1)
    expect(w.dirs.directories.get(DIRECTORY)!.name).toBe("Okta")
    expect(w.identity.events).toEqual([])
    expect((await w.call("user_owner", "GET", "/identity/directories")).status).toBe(
      200,
    )
    w.setFresh(true)
    expect(
      (await w.call("user_owner", "POST", "/identity/directories", { name: "Entra" }))
        .status,
    ).toBe(201)
  })
})

describe("directories: input", () => {
  it("refuses bodies with unknown fields, empty names, odd providers and out-of-range overlaps", async () => {
    const w = consoleApp()
    for (const body of [
      {},
      { name: "" },
      { name: "   " },
      { name: "x".repeat(101) },
      { name: "A", provider: "ldap" },
      { name: "A", enabled: false },
      { name: 5 },
    ])
      expect(
        (await w.call("user_owner", "POST", "/identity/directories", body)).status,
      ).toBe(422)
    for (const body of [
      {},
      { name: "" },
      { enabled: "yes" },
      { name: "A", extra: 1 },
      { enabled: null },
    ])
      expect(
        (
          await w.call(
            "user_owner",
            "PATCH",
            `/identity/directories/${DIRECTORY}`,
            body,
          )
        ).status,
      ).toBe(422)
    for (const overlapSeconds of [-1, 604_801, 1.5, "60", null])
      expect(
        (
          await w.call(
            "user_owner",
            "POST",
            `/identity/directories/${DIRECTORY}/tokens`,
            { overlapSeconds },
          )
        ).status,
      ).toBe(422)
    expect(
      (
        await w.call(
          "user_owner",
          "POST",
          `/identity/directories/${DIRECTORY}/tokens`,
          { other: 1 },
        )
      ).status,
    ).toBe(422)
    expect(w.dirs.tokens).toEqual([])
    expect(w.dirs.directories.size).toBe(1)
  })

  it("answers 404 for a directory that is not this workspace's, a malformed id and a token that is not there", async () => {
    const w = consoleApp()
    for (const id of [MISSING, "banana"]) {
      expect(
        (await w.call("user_owner", "GET", `/identity/directories/${id}`)).status,
      ).toBe(404)
      expect(
        (
          await w.call("user_owner", "PATCH", `/identity/directories/${id}`, {
            name: "x",
          })
        ).status,
      ).toBe(404)
      expect(
        (await w.call("user_owner", "POST", `/identity/directories/${id}/tokens`, {}))
          .status,
      ).toBe(404)
      expect(
        (await w.call("user_owner", "GET", `/identity/directories/${id}/conflicts`))
          .status,
      ).toBe(404)
      expect(
        (
          await w.call(
            "user_owner",
            "DELETE",
            `/identity/directories/${id}/tokens/${MISSING}`,
          )
        ).status,
      ).toBe(404)
    }
    expect(
      (
        await w.call(
          "user_owner",
          "DELETE",
          `/identity/directories/${DIRECTORY}/tokens/${MISSING}`,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await w.call(
          "user_owner",
          "DELETE",
          `/identity/directories/${DIRECTORY}/tokens/banana`,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await w.call(
          "user_owner",
          "POST",
          `/identity/directories/${DIRECTORY}/conflicts/${MISSING}/retry`,
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await w.call(
          "user_owner",
          "POST",
          `/identity/directories/${DIRECTORY}/conflicts/banana/retry`,
        )
      ).status,
    ).toBe(404)
  })

  it("caps the directories in a workspace", async () => {
    const w = consoleApp()
    for (let i = 1; i < MAX_DIRECTORIES; i++)
      expect(
        (await w.call("user_owner", "POST", "/identity/directories", { name: `D${i}` }))
          .status,
      ).toBe(201)
    const over = await w.call("user_owner", "POST", "/identity/directories", {
      name: "One too many",
    })
    expect(over.status).toBe(422)
    expect(w.dirs.directories.size).toBe(MAX_DIRECTORIES)
  })

  it("does not revoke a token twice", async () => {
    const w = consoleApp()
    const issued = await json(
      await w.call(
        "user_owner",
        "POST",
        `/identity/directories/${DIRECTORY}/tokens`,
        {},
      ),
    )
    const path = `/identity/directories/${DIRECTORY}/tokens/${issued.id}`
    expect((await w.call("user_admin", "DELETE", path)).status).toBe(200)
    expect((await w.call("user_admin", "DELETE", path)).status).toBe(404)
    expect(w.events("directory.token_revoked")).toHaveLength(1)
  })
})

describe("directories: what they do", () => {
  it("adds a directory with its base URL and audits it with the actor", async () => {
    const w = consoleApp()
    const res = await w.call("user_owner", "POST", "/identity/directories", {
      name: " Entra ",
      provider: "entra",
    })
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body).toMatchObject({
      name: "Entra",
      provider: "entra",
      enabled: true,
      baseUrl: `${BASE}/${body.id}`,
    })
    expect(w.events("directory.created")).toMatchObject([
      { actorUserId: "user_owner", data: { directoryId: body.id, provider: "entra" } },
    ])
    const defaulted = await json(
      await w.call("user_owner", "POST", "/identity/directories", { name: "Plain" }),
    )
    expect(defaulted.provider).toBe("generic")
  })

  it("lists directories with tokens (never their secrets), counts and the pending entries, and kicks them", async () => {
    const w = consoleApp()
    const issued = await json(
      await w.call(
        "user_owner",
        "POST",
        `/identity/directories/${DIRECTORY}/tokens`,
        {},
      ),
    )
    const list = await json(await w.call("user_admin", "GET", "/identity/directories"))
    expect(list).toMatchObject({ max: MAX_DIRECTORIES })
    expect(list.data[0]).toMatchObject({
      id: DIRECTORY,
      baseUrl: `${BASE}/${DIRECTORY}`,
      users: 0,
      conflicts: 0,
      pending: 0,
      tokens: [{ id: issued.id, hint: issued.hint }],
    })
    expect(JSON.stringify(list)).not.toContain(issued.token)
    expect(JSON.stringify(list)).not.toContain("tokenHash")
    expect(w.kicks).toEqual([{ directoryId: DIRECTORY, force: false }])
    const one = await json(
      await w.call("user_admin", "GET", `/identity/directories/${DIRECTORY}`),
    )
    expect(one.tokens).toHaveLength(1)
    expect(JSON.stringify(one)).not.toContain(issued.token)
  })

  it("shows the token once, stores only its hash, and never audits it", async () => {
    const w = consoleApp()
    const res = await w.call(
      "user_owner",
      "POST",
      `/identity/directories/${DIRECTORY}/tokens`,
      {},
    )
    expect(res.status).toBe(201)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await json(res)
    expect(body.token.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(readToken(`Bearer ${body.token}`)).toBe(body.token)
    expect(body.baseUrl).toBe(`${BASE}/${DIRECTORY}`)
    expect(body.hint).toBe(body.token.slice(0, TOKEN_PREFIX.length + 4))
    // At rest: the hash of it, and nothing else of it but the hint.
    expect(w.dirs.tokens).toHaveLength(1)
    expect(w.dirs.tokens[0]!.tokenHash).toBe(hashSecret(body.token))
    expect(JSON.stringify(w.dirs.tokens)).not.toContain(body.token)
    // Never again: not on a read, not in the audit log.
    expect(JSON.stringify(w.identity.events)).not.toContain(body.token)
    expect(JSON.stringify(w.identity.events)).not.toContain(hashSecret(body.token))
    expect(w.events("directory.token_issued")).toMatchObject([
      {
        actorUserId: "user_owner",
        data: { directoryId: DIRECTORY, tokenId: body.id, overlapSeconds: 86_400 },
      },
    ])
    // Two tokens are two different secrets.
    const second = await json(
      await w.call(
        "user_owner",
        "POST",
        `/identity/directories/${DIRECTORY}/tokens`,
        {},
      ),
    )
    expect(second.token).not.toBe(body.token)
  })

  it("rotates: the older token ends after the overlap, at once with zero", async () => {
    const w = consoleApp()
    await json(
      await w.call(
        "user_owner",
        "POST",
        `/identity/directories/${DIRECTORY}/tokens`,
        {},
      ),
    )
    await json(
      await w.call("user_owner", "POST", `/identity/directories/${DIRECTORY}/tokens`, {
        overlapSeconds: 3600,
      }),
    )
    const [first, second] = w.dirs.tokens
    expect(first!.expiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(3_600_000)
    expect(first!.expiresAt!.getTime() - Date.now()).toBeGreaterThan(3_500_000)
    expect(second!.expiresAt).toBeNull()
    await json(
      await w.call("user_owner", "POST", `/identity/directories/${DIRECTORY}/tokens`, {
        overlapSeconds: 0,
      }),
    )
    expect(w.dirs.tokens[1]!.revokedAt).not.toBeNull()
    expect(w.dirs.tokens[2]!.revokedAt).toBeNull()
  })

  it("updates a directory, audits from and to, and replays what it said while off when it is enabled again", async () => {
    const w = consoleApp()
    const off = await json(
      await w.call("user_admin", "PATCH", `/identity/directories/${DIRECTORY}`, {
        enabled: false,
        name: "Okta (paused)",
      }),
    )
    expect(off).toMatchObject({ enabled: false, name: "Okta (paused)" })
    expect(w.kicks).toEqual([])
    await w.call("user_owner", "PATCH", `/identity/directories/${DIRECTORY}`, {
      enabled: true,
    })
    expect(w.kicks).toEqual([{ directoryId: DIRECTORY, force: true }])
    expect(w.events("directory.updated")).toMatchObject([
      {
        actorUserId: "user_admin",
        data: {
          from: { name: "Okta", enabled: true },
          to: { name: "Okta (paused)", enabled: false },
        },
      },
      {
        actorUserId: "user_owner",
        data: { from: { enabled: false }, to: { enabled: true } },
      },
    ])
  })

  it("revokes a token and audits it", async () => {
    const w = consoleApp()
    const issued = await json(
      await w.call(
        "user_owner",
        "POST",
        `/identity/directories/${DIRECTORY}/tokens`,
        {},
      ),
    )
    expect(
      (
        await w.call(
          "user_admin",
          "DELETE",
          `/identity/directories/${DIRECTORY}/tokens/${issued.id}`,
        )
      ).status,
    ).toBe(200)
    expect(w.dirs.tokens[0]!.revokedAt).not.toBeNull()
    expect(w.events("directory.token_revoked")).toMatchObject([
      {
        actorUserId: "user_admin",
        data: { directoryId: DIRECTORY, tokenId: issued.id },
      },
    ])
  })

  it("lists the people with a conflict, and queues one of them to be looked at again", async () => {
    const w = consoleApp()
    const made = await w.dirs.store.createUser(
      TENANT,
      DIRECTORY,
      {
        userName: "ada@acme.test",
        externalId: null,
        displayName: "Ada",
        givenName: null,
        familyName: null,
        email: "ada@acme.test",
        active: true,
        resource: {},
      },
      { type: "scim.user.created" },
    )
    if (made === "taken") throw new Error("taken")
    await w.dirs.store.setConflict(
      TENANT,
      made.row.id,
      "profile_incomplete",
      null,
      new Date(),
    )
    const list = await json(
      await w.call("user_admin", "GET", `/identity/directories/${DIRECTORY}/conflicts`),
    )
    expect(list.data).toMatchObject([
      {
        id: made.row.id,
        userName: "ada@acme.test",
        conflict: "profile_incomplete",
        active: true,
        deleted: false,
      },
    ])
    const before = w.dirs.outbox.length
    const retry = await w.call(
      "user_admin",
      "POST",
      `/identity/directories/${DIRECTORY}/conflicts/${made.row.id}/retry`,
    )
    expect(retry.status).toBe(200)
    expect(w.dirs.outbox.length).toBe(before + 1)
    expect(w.scheduled).toEqual([made.row.id])
    expect(w.events("directory.user_retried")).toMatchObject([
      { actorUserId: "user_admin", data: { directoryUserId: made.row.id } },
    ])
  })

  it("keeps a token's hash out of every response", async () => {
    const w = consoleApp()
    const { token, hash } = scimToken("known")
    await w.dirs.store.issueToken(
      TENANT,
      DIRECTORY,
      { tokenHash: hash, hint: "i10_scim_know", createdBy: "u", overlapMs: 0 },
      new Date(),
    )
    const all = JSON.stringify([
      await json(await w.call("user_owner", "GET", "/identity/directories")),
      await json(
        await w.call("user_owner", "GET", `/identity/directories/${DIRECTORY}`),
      ),
    ])
    expect(all).not.toContain(hash)
    expect(all).not.toContain(token)
  })
})
