import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import { Hono } from "hono"
import postgres from "postgres"
import { withTenant, type Database } from "../src/db/client.js"
import type { Role } from "../src/console/roles.js"
import {
  accessTxtName,
  accessTxtValue,
  joinStore,
  recheckAccessDomains,
} from "../src/console/join.js"
import { mirrorPassthrough } from "../src/identity/authd-mirror.js"
import { identityStore } from "../src/identity/store.js"
import { fixedWindow } from "../src/identity/rate-limit.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import { mountIdentity } from "../src/routes/console/identity.js"
import { log, memoryClerk } from "./identity-fakes.js"
import { testSealer } from "./support/sealer.js"

/**
 * A change to what a connection's mail pass-through answers ends the mail
 * sign-ins made under the old answer, in the change's own transaction (#383),
 * against a real database as `i10_api`.
 *
 * `authd.passthrough_versions` moves, which makes authd fetch the settings again
 * instead of answering from its copy, and the `credential_epoch` of every
 * account the connection manages moves with it, which ends authd's cached
 * successes and makes the mail front (services/authd/internal/mailfront) close
 * the IMAP and SMTP sessions already open. Every path that moves the answer is
 * here: the console's LDAP routes, the connection's status, the OIDC lane, a
 * domain proof lapsing, coming back and being displaced.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@127.0.0.1:55432/i10 bun test test/passthrough-mirror-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const suffix = acme.slice(0, 8)
const other = `user_other_${suffix}`
const users: string[] = [other]
const box = testSealer()
const ROLES: Record<string, Role> = { user_owner: "owner", user_admin: "admin" }

const LDAP_ON = {
  host: "ldap.acme.test",
  port: 636,
  tlsMode: "ldaps",
  searchBase: "ou=people,dc=acme,dc=test",
  userFilter: "(mail={email})",
  serviceSet: true,
  revision: 1,
  testedAt: new Date().toISOString(),
  enabled: true,
}

suite("a pass-through change ends the sign-ins made under the old answer", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle({ client: db }) as unknown as Database
    for (const [id, tag] of [
      [acme, "a"],
      [rival, "r"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`p${tag}-${suffix}`}, 'T', ${`owner-${id}`}, ${`org_${tag}${suffix}`})`
    await owner`insert into authd.accounts (clerk_user_id, email, active, credential_epoch)
                values (${other}, ${`${other}@acme.test`}, true, 10)`
  })
  afterAll(async () => {
    await owner`delete from authd.accounts where clerk_user_id in ${owner(users)}`
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  const store = () => identityStore(database, box)
  const epoch = async (userId: string) => {
    const [row] =
      await owner`select credential_epoch from authd.accounts where clerk_user_id = ${userId}`
    return Number(row!.credential_epoch)
  }
  const version = async (connectionId: string) => {
    const [row] =
      await owner`select version from authd.passthrough_versions where connection_id = ${connectionId}`
    return row ? Number(row.version) : 0
  }

  /**
   * A live connection with LDAP pass-through on, backed by a live proof of its
   * own domain, managing one new person: pass-through really answers.
   */
  const setUp = async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const ada = `user_ada_${tag}`
    const name = `pt-${tag}.test`
    users.push(ada)
    await owner`insert into authd.accounts (clerk_user_id, email, active, credential_epoch)
                values (${ada}, ${`${ada}@${name}`}, true, 10)`
    const connection = await store().createConnection(acme, {
      name: `LDAP ${tag}`,
      protocol: "test",
      provider: "generic",
      createdBy: "u",
    })
    await store().setConnectionSecrets(acme, connection.id, (cur) => ({
      secrets: { ...cur.secrets, ldap: { bindDn: "cn=i10", bindSecret: "s" } },
      config: { ...cur.config, ldap: LDAP_ON },
    }))
    await store().updateConnection(acme, connection.id, { status: "active" })
    const [proof] = await owner`insert into core.join_domains
      (tenant_id, name, clerk_org_id, source, token, verified_at)
      values (${acme}, ${name}, ${`org_a${suffix}`}, 'txt', ${`tok-${tag}`}, now()) returning id`
    expect(await store().addDomain(acme, connection.id, proof!.id as string)).toBe(
      "added",
    )
    await store().claimManaged(acme, {
      clerkUserId: ada,
      tenantId: acme,
      connectionId: connection.id,
      reason: "linked" as const,
      emails: [`${ada}@${name}`],
    })
    return { connectionId: connection.id, ada, name, proofId: proof!.id as string, tag }
  }

  /** What a raise looks like: both the version and the person's epoch moved, once. */
  const expectRaised = async (
    connectionId: string,
    ada: string,
    before: { epoch: number; version: number },
  ) => {
    expect(await version(connectionId)).toBe(before.version + 1)
    expect(await epoch(ada)).toBe(before.epoch + 1)
    // Nobody the connection does not manage is touched.
    expect(await epoch(other)).toBe(10)
  }
  /** `authd.passthrough_versions.active`: true, false, null, or undefined for no row. */
  const active = async (connectionId: string) => {
    const [row] =
      await owner`select active from authd.passthrough_versions where connection_id = ${connectionId}`
    return row ? (row.active as boolean | null) : undefined
  }
  const now = async (connectionId: string, ada: string) => ({
    epoch: await epoch(ada),
    version: await version(connectionId),
  })

  const app = (userId: string) => {
    const a = new Hono()
    a.use("*", async (c, next) => {
      c.set("auth", { apiKeyId: "", tenantId: acme, scopes: [], mode: "live" } as never)
      c.set("user", { userId, orgId: `org_a${suffix}` } as never)
      c.set("freshAuth", (async () => ({ status: "fresh" })) as never)
      await next()
    })
    mountIdentity(a, {
      roles: { store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null } },
      identity: {
        store: store(),
        clerk: memoryClerk().clerk,
        gate: { forget: () => {} },
        protocols: ["test"],
        deprovision: {},
        log,
        ldap: {
          probe: { run: async () => ({ result: "ok" }) },
          take: fixedWindow(null),
        },
      },
    } as unknown as ConsoleDeps)
    return a
  }
  const call = (userId: string, method: string, path: string, body: unknown) =>
    app(userId).request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  describe("the console's changes", () => {
    it("an admin switching LDAP pass-through off", async () => {
      const { connectionId, ada } = await setUp()
      const before = await now(connectionId, ada)
      const res = await call(
        "user_admin",
        "PUT",
        `/identity/connections/${connectionId}/ldap`,
        {
          enabled: false,
        },
      )
      expect(res.status).toBe(200)
      await expectRaised(connectionId, ada, before)
    })

    it("the directory's settings changing", async () => {
      const { connectionId, ada } = await setUp()
      const before = await now(connectionId, ada)
      const res = await call(
        "user_owner",
        "PUT",
        `/identity/connections/${connectionId}/ldap`,
        {
          host: "ldap2.acme.test",
        },
      )
      expect(res.status).toBe(200)
      await expectRaised(connectionId, ada, before)
    })

    it("the service account changing", async () => {
      const { connectionId, ada } = await setUp()
      const before = await now(connectionId, ada)
      const res = await call(
        "user_owner",
        "PUT",
        `/identity/connections/${connectionId}/ldap/service`,
        { bindDn: "cn=new,dc=acme,dc=test", bindSecret: "another-secret" },
      )
      expect(res.status).toBe(200)
      await expectRaised(connectionId, ada, before)
    })

    // The console's status route (routes/console/identity.ts), active to disabled.
    // ⚠ And `active` follows, in the same statement: authd's gate refuses the
    // connection's managed accounts on it (`connection_inactive`), which is what
    // holds their mail device codes.
    it("the connection stopping being active", async () => {
      const { connectionId, ada } = await setUp()
      expect(await active(connectionId)).toBe(true)
      const before = await now(connectionId, ada)
      const res = await call(
        "user_owner",
        "PATCH",
        `/identity/connections/${connectionId}`,
        {
          status: "disabled",
        },
      )
      expect(res.status).toBe(200)
      await expectRaised(connectionId, ada, before)
      expect(await active(connectionId)).toBe(false)

      const disabled = await now(connectionId, ada)
      expect(
        (
          await call("user_owner", "PATCH", `/identity/connections/${connectionId}`, {
            status: "active",
          })
        ).status,
      ).toBe(200)
      await expectRaised(connectionId, ada, disabled)
      expect(await active(connectionId)).toBe(true)
    })

    it("the OIDC lane's settings changing", async () => {
      const { connectionId, ada } = await setUp()
      const before = await now(connectionId, ada)
      await store().setConnectionSecrets(acme, connectionId, (cur) => ({
        secrets: cur.secrets,
        config: {
          ...cur.config,
          oidcMail: { preset: "okta", issuer: "https://acme.okta.com", enabled: true },
        },
      }))
      await expectRaised(connectionId, ada, before)
    })
  })

  // ⚠ The hash is by position: the same value under the other lane's key is a
  // different answer, and must not hash like the old one.
  it("the same settings moving from one lane's key to the other", async () => {
    const { connectionId, ada } = await setUp()
    const before = await now(connectionId, ada)
    // updateConnection, not setConnectionSecrets: the secrets are not sealed
    // again, so only the position of the settings changes.
    const [row] =
      await owner`select config from identity.connections where id = ${connectionId}`
    const { ldap, ...rest } = row!.config as Record<string, unknown>
    await store().updateConnection(acme, connectionId, {
      config: { ...rest, oidcMail: ldap },
    })
    await expectRaised(connectionId, ada, before)
  })

  // ⚠ A ROW AN OLDER API POD WROTE has no `active` (null, which authd reads as
  // "unknown" and refuses nothing). The next mirror fills it in, and since the
  // answer did not move, raises neither the version nor anybody's epoch.
  it("fills in a row with no active without a raise", async () => {
    const { connectionId, ada } = await setUp()
    await owner`update authd.passthrough_versions set active = null where connection_id = ${connectionId}`
    const before = await now(connectionId, ada)
    await withTenant(database, acme, (tx) => mirrorPassthrough(tx, acme))
    expect(await active(connectionId)).toBe(true)
    expect(await now(connectionId, ada)).toEqual(before)
  })

  describe("changes that do not move the answer", () => {
    // ⚠ A SAML METADATA REFRESH WRITES THE CONFIG ON A SCHEDULE, and a rename is a
    // rename: neither may sign every managed person's mail out.
    it("a rename, or another feature's settings, raises nothing", async () => {
      const { connectionId, ada } = await setUp()
      const before = await now(connectionId, ada)
      await store().updateConnection(acme, connectionId, { name: "Renamed" })
      const [row] =
        await owner`select config from identity.connections where id = ${connectionId}`
      await store().updateConnection(acme, connectionId, {
        config: { ...(row!.config as object), saml: { metadataRefreshedAt: "now" } },
      })
      expect(await now(connectionId, ada)).toEqual(before)
    })
  })

  describe("the domain proof behind it", () => {
    const only =
      (name: string, answer: () => string[]) =>
      async (txt: string): Promise<string[]> => {
        // Every other workspace's due proof in this database is left unchecked.
        if (txt !== accessTxtName(name)) throw new Error("not this test's")
        return answer()
      }

    it("lapsing, and coming back", async () => {
      const { connectionId, ada, name, tag } = await setUp()
      const before = await now(connectionId, ada)
      await recheckAccessDomains({
        db: database,
        lookup: only(name, () => []),
      })
      await expectRaised(connectionId, ada, before)
      // `active` is the status alone: a lapsed proof is pass-through's answer
      // (the version moved), not the connection's status.
      expect(await active(connectionId)).toBe(true)

      const lapsed = await now(connectionId, ada)
      await recheckAccessDomains({
        db: database,
        lookup: only(name, () => [`"${accessTxtValue(`tok-${tag}`)}"`]),
        // A day on, so the proof checked a moment ago is due again.
        now: () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      })
      await expectRaised(connectionId, ada, lapsed)
    })

    it("being displaced by another workspace's proof of the name", async () => {
      const { connectionId, ada, name } = await setUp()
      const before = await now(connectionId, ada)
      const [theirs] = await owner`insert into core.join_domains
        (tenant_id, name, clerk_org_id, source, token)
        values (${rival}, ${name}, ${`org_r${suffix}`}, 'txt', 'rival-tok') returning id`
      expect(
        await joinStore(database).verifyTxt(rival, theirs!.id as string, async () => [
          `"${accessTxtValue("rival-tok")}"`,
        ]),
      ).toBe("proven")
      await expectRaised(connectionId, ada, before)
    })
  })

  // ⚠ THE WHOLE POINT: the change and its raise commit together or not at all.
  it("rolls back with the change that would have moved it", async () => {
    const { connectionId, ada } = await setUp()
    const before = await now(connectionId, ada)
    let mirrored = false
    const failed = await withTenant(database, acme, async (tx) => {
      await tx.execute(
        sql`update identity.connections set status = 'disabled' where id = ${connectionId}`,
      )
      await mirrorPassthrough(tx, acme)
      // Inside the transaction the raise is there; it must not outlive it.
      const [row] = (await tx.execute(
        sql`select version from authd.passthrough_versions where connection_id = ${connectionId}`,
      )) as unknown as { version: string }[]
      mirrored = Number(row!.version) === before.version + 1
      throw new Error("the change fails after the mirror ran")
    }).then(
      () => false,
      () => true,
    )
    expect(failed).toBe(true)
    expect(mirrored).toBe(true)
    expect(await now(connectionId, ada)).toEqual(before)
  })
})
