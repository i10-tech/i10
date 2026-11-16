import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import { connectionHealthStore } from "../src/identity/health-store.js"
import { hashSecret } from "../src/identity/model.js"
import { checkDirectoryTokens, checkOidcSecret } from "../src/identity/saml-refresh.js"
import { directoryStore } from "../src/identity/scim-store.js"
import { identityStore } from "../src/identity/store.js"
import { log } from "./identity-fakes.js"

/**
 * The daily identity expiry pass's tenant list against a real database as
 * `i10_api`, with no tenant set: `identity.expiry_tenants_due` behind
 * `dueExpiryTenants`, and the per-tenant checks the pass runs on its answer.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/<scratch> bun test test/identity-expiry-tenants-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
const withOidc = crypto.randomUUID()
const withDirectory = crypto.randomUUID()
const withNeither = crypto.randomUUID()
const DAY_MS = 86_400_000

/** Every page of `dueExpiryTenants`, as the pass reads it. */
async function allDue(): Promise<string[]> {
  const seen: string[] = []
  for (let after: string | null = null; ;) {
    const page = await identityStore(database, null).dueExpiryTenants(after, 2)
    if (!page.length) return seen
    seen.push(...page)
    after = page.at(-1)!
  }
}

suite("identity expiry tenants", () => {
  let oidcId = ""
  let directoryId = ""
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle({ client: db }) as unknown as Database
    for (const id of [withOidc, withDirectory, withNeither])
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                  values (${id}, ${`x-${id.slice(0, 8)}`}, 'T', ${`owner-${id}`})`
    const store = identityStore(database, null)
    const oidc = await store.createConnection(withOidc, {
      name: "OIDC",
      protocol: "oidc",
      provider: "okta",
      createdBy: "u",
    })
    oidcId = oidc.id
    await store.updateConnection(withOidc, oidcId, {
      config: {
        oidc: { secretExpiresAt: new Date(Date.now() + 3 * DAY_MS).toISOString() },
      },
    })
    await store.createConnection(withNeither, {
      name: "SAML only",
      protocol: "saml",
      provider: "okta",
      createdBy: "u",
    })
    directoryId = (
      await directoryStore(database).createDirectory(withDirectory, {
        name: "Okta",
        provider: "okta",
        createdBy: "u",
      })
    ).id
    // The second token gives the first an expiry a day out.
    for (const hint of ["i10_scim_one", "i10_scim_two"])
      await directoryStore(database).issueToken(
        withDirectory,
        directoryId,
        { tokenHash: hashSecret(hint), hint, createdBy: "u", overlapMs: DAY_MS },
        new Date(),
      )
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id in (${withOidc}, ${withDirectory}, ${withNeither})`
    await owner.end()
    await db.end()
  })

  it("answers where reading core.tenants with an empty tenant throws", async () => {
    // The production shape: a pooled session whose tenant reverted to "".
    const read = (query: string) =>
      db
        .begin(async (tx) => {
          await tx`select set_config('app.tenant_id', '', true)`
          return tx.unsafe(query)
        })
        .then(
          (rows) => ({ rows: rows.length, error: "" }),
          (err: unknown) => ({ rows: 0, error: String(err) }),
        )
    expect((await read("select id from core.tenants")).error).toContain(
      'invalid input syntax for type uuid: ""',
    )
    const due = await read(
      "select tenant_id from identity.expiry_tenants_due(null, 500)",
    )
    expect(due.error).toBe("")
    expect(due.rows).toBeGreaterThan(0)
  })

  it("lists a workspace with an OIDC connection or a directory, and not one with neither", async () => {
    const due = await allDue()
    expect(due).toContain(withOidc)
    expect(due).toContain(withDirectory)
    expect(due).not.toContain(withNeither)
    expect(new Set(due).size).toBe(due.length)
  })

  it("lets the pass read and write each listed workspace under its own tenant", async () => {
    const store = identityStore(database, null)
    const now = new Date()
    const [conn] = await store.connections(withOidc)
    expect(conn?.id).toBe(oidcId)
    expect(await checkOidcSecret({ store, log }, conn!, now)).toBe(true)
    expect(
      (await store.connection(withOidc, oidcId))?.config.oidc as {
        secretAlertedDays?: number
      },
    ).toMatchObject({ secretAlertedDays: 7 })

    const [dir] = await directoryStore(database).directories(withDirectory)
    expect(dir?.id).toBe(directoryId)
    expect(
      await checkDirectoryTokens(
        { store, health: connectionHealthStore(database), log },
        dir!,
        dir!.tokens,
        now,
      ),
    ).toBe(1)

    const events = await owner<{ tenant_id: string; kind: string }[]>`
      select tenant_id, data->>'kind' as kind from identity.events
       where type = 'sso.certificate.expiring'
         and tenant_id in (${withOidc}, ${withDirectory})
       order by kind`
    expect([...events]).toEqual([
      { tenant_id: withOidc, kind: "client_secret" },
      { tenant_id: withDirectory, kind: "scim_token" },
    ])
  })
})
