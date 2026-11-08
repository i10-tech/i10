import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import { Hono } from "hono"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { identityStore } from "../src/identity/store.js"
import { mintHookSecret } from "../src/identity/okta-event-hook.js"
import { fixedWindow } from "../src/identity/rate-limit.js"
import { raiseConnectionCredentialEpochs } from "../src/projection/connection-epoch.js"
import { raiseCredentialEpoch } from "../src/projection/credential-epoch.js"
import { createOktaEventHooks } from "../src/routes/okta-event-hooks.js"
import { secretBox } from "../src/webhooks/signing.js"

/**
 * An Okta event hook against a real database as `i10_api`: the connection is
 * found by an unauthenticated caller through row level security, the hash
 * survives the jsonb round trip, and `raiseCredentialEpoch` moves exactly the
 * right `authd.accounts` rows.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch_383 bun test test/identity-okta-event-hook-db.test.ts
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
const ada = `user_ada_${suffix}`
const bob = `user_bob_${suffix}`
const rivalAda = `user_rival_ada_${suffix}`
const ghost = `user_ghost_${suffix}`
const box = secretBox("ab".repeat(32))

suite("Okta event hook against Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`a-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
    for (const id of [ada, bob, rivalAda])
      await owner`insert into authd.accounts (clerk_user_id, email) values (${id}, ${`${id}@mail.test`})`
  })
  afterAll(async () => {
    await owner`delete from authd.accounts where clerk_user_id in (${ada}, ${bob}, ${rivalAda})`
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  const store = () => identityStore(database, box)
  const epoch = async (id: string) =>
    Number(
      (
        await owner`select credential_epoch from authd.accounts where clerk_user_id = ${id}`
      )[0]!.credential_epoch,
    )
  const touched = async (id: string) =>
    (
      await owner`select clerk_updated_at, active from authd.accounts where clerk_user_id = ${id}`
    )[0]!

  // Built once the database exists, which is after this block has run.
  const app = () =>
    new Hono().route(
      "/webhooks",
      createOktaEventHooks({
        store: store(),
        raiseEpoch: async (id) => {
          await raiseCredentialEpoch(database, id)
        },
        raiseConnection: async (id) => {
          await raiseConnectionCredentialEpochs(database, id)
        },
        take: fixedWindow(null),
        contextSecret: undefined,
        edgeSecret: undefined,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      }),
    )
  const post = (connectionId: string, auth: string | null, events: unknown[]) =>
    app().request(`/webhooks/okta/${connectionId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify({ data: { events } }),
    })
  const event = (eventType: string, oktaId: string, login: string) => ({
    uuid: crypto.randomUUID(),
    published: new Date().toISOString(),
    eventType,
    outcome: { result: "SUCCESS" },
    target: [{ id: oktaId, type: "User", alternateId: login }],
  })

  let acmeConn = ""
  let rivalConn = ""
  let acmeSecret = ""
  let rivalSecret = ""

  /** The secret goes in through the real store, under its row lock, like the console does. */
  async function issue(tenantId: string, connectionId: string) {
    const made = mintHookSecret(new Date())
    await store().setConnectionSecrets(tenantId, connectionId, (cur) => ({
      secrets: cur.secrets,
      config: { ...cur.config, oktaEventHook: made.stored },
    }))
    return made.secret
  }

  it("sets up two workspaces, each with an Okta connection, a secret and linked people", async () => {
    const a = await store().createConnection(acme, {
      name: "Acme Okta",
      protocol: "oidc",
      provider: "okta",
      createdBy: "u",
    })
    const r = await store().createConnection(rival, {
      name: "Rival Okta",
      protocol: "oidc",
      provider: "okta",
      createdBy: "u",
    })
    acmeConn = a.id
    rivalConn = r.id
    acmeSecret = await issue(acme, acmeConn)
    rivalSecret = await issue(rival, rivalConn)
    await store().link(acme, {
      connectionId: acmeConn,
      subject: "00u_ada",
      clerkUserId: ada,
      email: "ada@acme.test",
    })
    await store().link(acme, {
      connectionId: acmeConn,
      subject: "00u_bob",
      clerkUserId: bob,
      email: "bob@acme.test",
    })
    // Linked, but with no mailbox row: nothing is cached for them.
    await store().link(acme, {
      connectionId: acmeConn,
      subject: "00u_ghost",
      clerkUserId: ghost,
      email: "ghost@acme.test",
    })
    // The same Okta id string, in another workspace.
    await store().link(rival, {
      connectionId: rivalConn,
      subject: "00u_ada",
      clerkUserId: rivalAda,
      email: "ada@rival.test",
    })
  })

  it("stores the hash and not the secret, in the connection's config", async () => {
    const row =
      await owner`select config, secrets from identity.connections where id = ${acmeConn}`
    const config = JSON.stringify(row[0]!.config)
    expect(config).toContain("secretHash")
    expect(config).not.toContain(acmeSecret)
    expect(String(row[0]!.secrets)).not.toContain(acmeSecret)
  })

  it("refuses without the secret, with another connection's, and with a wrong one, and moves nothing", async () => {
    const events = [event("user.account.update_password", "00u_ada", "ada@acme.test")]
    for (const auth of [null, "nope", rivalSecret])
      expect((await post(acmeConn, auth, events)).status).toBe(401)
    expect(
      (await post("00000000-0000-4000-8000-000000000000", acmeSecret, events)).status,
    ).toBe(401)
    expect(await epoch(ada)).toBe(0)
    expect(await epoch(bob)).toBe(0)
    expect(await epoch(rivalAda)).toBe(0)
  })

  it("raises the epoch of the person an event names, and of nobody else", async () => {
    const res = await post(acmeConn, acmeSecret, [
      event("user.account.update_password", "00u_ada", "ada@acme.test"),
    ])
    expect(res.status).toBe(200)
    expect(await epoch(ada)).toBe(1)
    expect(await epoch(bob)).toBe(0)
    // The other workspace's person with the same Okta id string.
    expect(await epoch(rivalAda)).toBe(0)
  })

  it("changes only the epoch: the account stays active and clerk_updated_at stays put", async () => {
    const before = await touched(bob)
    await post(acmeConn, acmeSecret, [
      event("user.session.clear", "00u_bob", "bob@acme.test"),
    ])
    expect(await epoch(bob)).toBe(1)
    expect(await touched(bob)).toEqual(before)
  })

  it("raises again on a replay, and once per person in a batch", async () => {
    await post(acmeConn, acmeSecret, [
      event("user.lifecycle.suspend", "00u_ada", "ada@acme.test"),
      event("user.lifecycle.deactivate", "00u_ada", "ada@acme.test"),
    ])
    expect(await epoch(ada)).toBe(2)
  })

  it("finds a person by the address when the Okta id is not the link's subject", async () => {
    await post(acmeConn, acmeSecret, [
      event("user.account.reset_password", "00u_other_id", "BOB@acme.test"),
    ])
    expect(await epoch(bob)).toBe(2)
  })

  it("is a quiet success for a linked person with no mailbox, and for someone unknown", async () => {
    const res = await post(acmeConn, acmeSecret, [
      event("user.session.clear", "00u_ghost", "ghost@acme.test"),
      event("user.session.clear", "00u_nobody", "nobody@acme.test"),
    ])
    expect(res.status).toBe(200)
    expect(await epoch(ada)).toBe(2)
    expect(await epoch(bob)).toBe(2)
  })

  it("lets the other workspace's own secret reach only its own people", async () => {
    const res = await post(rivalConn, rivalSecret, [
      event("user.account.update_password", "00u_ada", "ada@rival.test"),
    ])
    expect(res.status).toBe(200)
    expect(await epoch(rivalAda)).toBe(1)
    expect(await epoch(ada)).toBe(2)
  })

  it("stops honouring a secret the moment a new one replaces it", async () => {
    const next = await issue(acme, acmeConn)
    const events = [event("user.account.update_password", "00u_ada", "ada@acme.test")]
    expect((await post(acmeConn, acmeSecret, events)).status).toBe(401)
    expect(await epoch(ada)).toBe(2)
    expect((await post(acmeConn, next, events)).status).toBe(200)
    expect(await epoch(ada)).toBe(3)
  })
})
