import { generateKeyPairSync } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import {
  GOOGLE_TOKEN_URL,
  createGoogleTokenSource,
  parseGoogleServiceAccount,
  pullGoogleDirectory,
} from "../src/identity/google-directory.js"
import { hashSecret } from "../src/identity/model.js"
import { guardedFetch } from "../src/identity/oidc-fetch.js"
import { directoryStore } from "../src/identity/scim-store.js"
import { identityStore } from "../src/identity/store.js"
import { vetHost } from "../src/webhooks/egress.js"
import { log } from "./identity-fakes.js"

/**
 * Google Workspace directory persistence against real Postgres as `i10_api`
 * (#343): RLS on `directory_watch_channels`, the outsider policy for
 * `watchChannelById`, the `google_directories_due` function behind
 * `dueGoogleDirectories`, check constraints, and
 * repeated-pull `jsonb` idempotency (zero outbox or audit writes when nothing
 * changed).
 */

const URL_ENV = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL_ENV?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL_ENV ? describe : describe.skip

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const SA = parseGoogleServiceAccount(
  JSON.stringify({
    type: "service_account",
    client_email: "sync@i10-test.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }),
)

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database

const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const liveDomain = `google-${acme.slice(0, 8)}.test`
const rivalDomain = `google-${rival.slice(0, 8)}.test`

const refusal = async (run: () => Promise<unknown>) => {
  try {
    await run()
    return "accepted"
  } catch (error) {
    return `${String(error)} ${String((error as { cause?: unknown }).cause ?? "")}`
  }
}

suite("Google Workspace directories in Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL_ENV!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const) {
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`g-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
    }
    await owner`insert into core.join_domains (tenant_id, name, clerk_org_id, source, verified_at)
                values (${acme}, ${liveDomain}, 'org_a', 'txt', now()),
                       (${rival}, ${rivalDomain}, 'org_r', 'txt', now())`
  })

  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  it("enforces RLS, composite FKs, check constraints, and exact-id outsider lookups on watch channels", async () => {
    const store = directoryStore(database)
    const acmeGoogle = await store.createDirectory(acme, {
      name: "Acme Google",
      provider: "google",
      adminEmail: `admin@${liveDomain}`,
      domain: liveDomain,
      createdBy: "u_owner",
    })
    // Google directories start disabled until an owner explicitly turns them on.
    expect(acmeGoogle.enabled).toBe(false)

    const rivalOkta = await store.createDirectory(rival, {
      name: "Rival Okta",
      provider: "okta",
      createdBy: "u_rival",
    })
    expect(rivalOkta.enabled).toBe(true)

    const channelId = crypto.randomUUID()
    const tokenHash = hashSecret("secret-channel-token")
    await store.saveWatchChannel(acme, {
      id: channelId,
      directoryId: acmeGoogle.id,
      event: "update",
      resourceId: "res_123",
      tokenHash,
      expiresAt: new Date(Date.now() + 3600_000),
    })

    // Rival cannot see, overwrite, or delete Acme's watch channels.
    expect(await store.watchChannels(rival, acmeGoogle.id)).toEqual([])
    expect(await store.deleteWatchChannels(rival, acmeGoogle.id)).toEqual([])
    expect(
      await refusal(() =>
        store.saveWatchChannel(rival, {
          id: crypto.randomUUID(),
          directoryId: acmeGoogle.id,
          event: "add",
          resourceId: "res_x",
          tokenHash,
          expiresAt: new Date(Date.now() + 3600_000),
        }),
      ),
    ).not.toBe("accepted")

    // Check constraints reject bogus sync status and bogus watch event names.
    expect(
      await refusal(() =>
        database.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${acme}, true)`)
          await tx.execute(
            sql`update identity.directories set last_sync_status = 'bogus' where id = ${acmeGoogle.id}`,
          )
        }),
      ),
    ).not.toBe("accepted")
    expect(
      await refusal(() =>
        database.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${acme}, true)`)
          await tx.execute(
            sql`insert into identity.directory_watch_channels
                (id, directory_id, tenant_id, event, resource_id, token_hash, expires_at)
                values (${crypto.randomUUID()}, ${acmeGoogle.id}, ${acme}, 'bogus', 'r', ${tokenHash}, now())`,
          )
        }),
      ),
    ).not.toBe("accepted")

    // Outsider lookup sees ONLY the one UUID named in `app.google_channel`.
    expect(await store.watchChannelById("not-a-uuid")).toBeNull()
    expect(await store.watchChannelById(crypto.randomUUID())).toBeNull()
    expect(await store.watchChannelById(channelId)).toMatchObject({
      id: channelId,
      tenantId: acme,
      directoryId: acmeGoogle.id,
      event: "update",
      tokenHash,
    })

    // With NO_TENANT and no `app.google_channel`, zero watch rows are visible.
    const leaked = await database.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true)`,
      )
      return tx.select().from(schema.directoryWatchChannels)
    })
    expect(leaked).toEqual([])
  })

  it("lists only enabled Google directories in `dueGoogleDirectories` and writes zero outbox or audit rows on an unchanged pull against real jsonb", async () => {
    const store = directoryStore(database)
    const idStore = identityStore(database, null)

    const dir = await store.createDirectory(acme, {
      name: "Live Google",
      provider: "google",
      adminEmail: `admin@${liveDomain}`,
      domain: liveDomain,
      createdBy: "u_owner",
    })

    // Disabled -> not in `dueGoogleDirectories`.
    const beforeEnable = await store.dueGoogleDirectories(null, 200)
    expect(beforeEnable.some((d) => d.id === dir.id)).toBe(false)

    await store.updateDirectory(acme, dir.id, { enabled: true })
    const afterEnable = await store.dueGoogleDirectories(null, 200)
    expect(afterEnable.some((d) => d.id === dir.id && d.tenantId === acme)).toBe(true)

    // Keyset paging: a page of one, then the rest after its id.
    const pageOne = await store.dueGoogleDirectories(null, 1)
    expect(pageOne).toHaveLength(1)
    const rest = await store.dueGoogleDirectories(pageOne[0]!.id, 200)
    expect(rest.some((d) => d.id === pageOne[0]!.id)).toBe(false)
    expect(afterEnable).toHaveLength(1 + rest.length)

    const gf = guardedFetch({
      vet: (host, signal) =>
        vetHost(host, {
          lookup: async () => [{ address: "142.250.74.106", family: 4 }],
          signal,
        }),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(input))
        const host = new Headers(init?.headers).get("host")
        if (host) u.host = host
        if (u.href === GOOGLE_TOKEN_URL) {
          return new Response(
            JSON.stringify({ access_token: "tok_db", expires_in: 3600 }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (u.pathname.endsWith("/users")) {
          return new Response(
            JSON.stringify({
              users: [
                {
                  id: "g_db_ada",
                  primaryEmail: `ada@${liveDomain}`,
                  name: { givenName: "Ada", familyName: "Lovelace" },
                  aliases: [`a@${liveDomain}`],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (u.pathname.endsWith("/groups")) {
          return new Response(
            JSON.stringify({
              groups: [{ id: "g_db_grp", email: `eng@${liveDomain}`, name: "Eng" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        return new Response(
          JSON.stringify({
            members: [{ id: "g_db_ada", type: "USER", status: "ACTIVE" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }) as typeof fetch,
    })

    const tokens = createGoogleTokenSource({ serviceAccount: SA, fetch: gf })
    const first = await pullGoogleDirectory(
      {
        store,
        tokens,
        fetch: gf,
        schedule: async () => {},
        record: (t, e) => idStore.record(t, e),
        log,
      },
      { tenantId: acme, directoryId: dir.id },
    )
    expect(first).toEqual({
      outcome: "ok",
      users: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
      groups: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
    })

    const countRows = async () => {
      const [outboxCount] = await owner<{ n: number }[]>`
        select count(*)::int as n from identity.directory_outbox where directory_id = ${dir.id}`
      const [auditCount] = await owner<{ n: number }[]>`
        select count(*)::int as n from identity.events where tenant_id = ${acme}`
      return { outbox: outboxCount!.n, audits: auditCount!.n }
    }

    const afterFirstCounts = await countRows()
    // 1 outbox row from createUser + 1 outbox row from createGroup membership.
    expect(afterFirstCounts.outbox).toBe(2)

    // Second pull against real Postgres jsonb: zero new outbox rows, zero new audit rows!
    const second = await pullGoogleDirectory(
      {
        store,
        tokens,
        fetch: gf,
        schedule: async () => {},
        record: (t, e) => idStore.record(t, e),
        log,
      },
      { tenantId: acme, directoryId: dir.id },
    )
    expect(second).toEqual({
      outcome: "ok",
      users: { created: 0, updated: 0, deleted: 0, unchanged: 1 },
      groups: { created: 0, updated: 0, deleted: 0, unchanged: 1 },
    })
    expect(await countRows()).toEqual(afterFirstCounts)

    const refreshed = await store.directory(acme, dir.id)
    expect(refreshed?.lastSyncStatus).toBe("ok")
    expect(refreshed?.lastSyncError).toBeNull()
    expect(refreshed?.lastSyncAt).toBeInstanceOf(Date)
  })

  it("stores a shrink-guard allowance only after a large_drop failure, per tenant, and clears it on success", async () => {
    const store = directoryStore(database)
    const dir = await store.createDirectory(acme, {
      name: "Acme drop",
      provider: "google",
      adminEmail: `admin@${liveDomain}`,
      domain: liveDomain,
      createdBy: "u_owner",
    })
    const at = new Date("2026-10-24T12:00:00Z")
    const allow = (tenant: string) =>
      store.allowDirectoryDrop(tenant, dir.id, { users: 7, at })

    // Nothing failed yet, then a different failure: nothing is stored.
    expect(await allow(acme)).toBe(false)
    await store.noteDirectorySync(acme, dir.id, {
      status: "failed",
      error: "unreachable",
      at,
    })
    expect(await allow(acme)).toBe(false)

    await store.noteDirectorySync(acme, dir.id, {
      status: "failed",
      error: "large_drop",
      at,
    })
    // Another workspace cannot give the go-ahead.
    expect(await allow(rival)).toBe(false)
    expect(await allow(acme)).toBe(true)
    expect(await store.directory(acme, dir.id)).toMatchObject({
      allowDropUpTo: 7,
      allowDropAt: at,
    })

    // A refusal that spends it clears both columns; so does any success.
    await store.noteDirectorySync(acme, dir.id, {
      status: "failed",
      error: "large_drop",
      at,
      clearDropAllowance: true,
    })
    expect(await store.directory(acme, dir.id)).toMatchObject({
      allowDropUpTo: null,
      allowDropAt: null,
    })
    expect(await allow(acme)).toBe(true)
    await store.noteDirectorySync(acme, dir.id, { status: "ok", error: null, at })
    expect(await store.directory(acme, dir.id)).toMatchObject({
      allowDropUpTo: null,
      allowDropAt: null,
    })
  })
})
