import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { webhookDeliveryOps } from "../src/webhooks/db.js"
import { verifyEd25519 } from "../src/webhooks/keys.js"
import { secretBox, verifySignature } from "../src/webhooks/signing.js"
import {
  webhookEndpointStore,
  type WebhookEndpointStore,
} from "../src/webhooks/store.js"
import { signWithKeys } from "../src/webhooks/keys.js"

/**
 * Rotation against a real database, as `i10_api` so row level security
 * applies: what is stored, what the worker signs with, and that two rotations
 * cannot lose each other's retiring key.
 *
 *   WEBHOOKS_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/webhooks_scratch bun test test/webhook-keys-db.test.ts
 */
const URL = process.env.WEBHOOKS_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const secrets = secretBox("ab".repeat(32))
let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let db: Database
let store: WebhookEndpointStore
const tenants: string[] = []

async function workspace() {
  const id = crypto.randomUUID()
  await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
              values (${id}, ${`t-${id.slice(0, 8)}`}, 'T', ${`wh-test-${id}`})`
  tenants.push(id)
  return id
}

/** The keys the worker would sign with right now, via the real load path. */
async function keysFor(tenantId: string, endpointId: string) {
  const [d] =
    await owner`insert into core.webhook_deliveries (tenant_id, endpoint_id, event_type, occurred_at, payload)
                          values (${tenantId}, ${endpointId}, 'email.sent', now(), '{}') returning id`
  const loaded = await webhookDeliveryOps({ db, secrets }).load({
    deliveryId: d!.id,
    endpointId,
    tenantId,
  })
  return loaded!.keys
}

const verifies = (secret: string, header: string) =>
  verifySignature(secret, "msg_1", "{}", header, String(Math.floor(Date.now() / 1000)))

suite("webhook signing keys in the database", () => {
  beforeAll(() => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 4, onnotice: () => {} })
    db = drizzle(app, { schema }) as unknown as Database
    store = webhookEndpointStore(db, secrets)
  })
  afterAll(async () => {
    if (tenants.length) await owner`delete from core.tenants where id = any(${tenants})`
    await owner.end()
    await app.end()
  })

  const create = async (t: string, scheme?: "ed25519" | "hmac_sha256") => {
    const r = await store.create(t, {
      url: "https://hooks.example.com/i10",
      events: ["email.sent"],
      ...(scheme ? { signature_scheme: scheme } : {}),
    })
    if (r.status !== "created") throw new Error(r.reason)
    return r.endpoint
  }

  it("revoke: only the new secret signs from the next delivery", async () => {
    const t = await workspace()
    const ep = await create(t)
    const r = await store.rotateSecret(t, ep.id, { action: "revoke" })
    if (r.status !== "rotated") throw new Error(r.status)
    expect(r.endpoint.previous_secrets).toEqual([])

    const header = signWithKeys(await keysFor(t, ep.id), "msg_1", "{}", new Date())
    expect(verifies(r.endpoint.secret!, header)).toBe(true)
    expect(verifies(ep.secret!, header)).toBe(false)
  })

  it("expire: both secrets sign until the chosen time, then revoke ends it early", async () => {
    const t = await workspace()
    const ep = await create(t)
    const r = await store.rotateSecret(t, ep.id, {
      action: "expire",
      expiresInSeconds: 3600,
    })
    if (r.status !== "rotated") throw new Error(r.status)
    expect(r.endpoint.previous_secrets).toHaveLength(1)
    expect(
      Date.parse(r.endpoint.previous_secrets[0]!.expires_at) - Date.now(),
    ).toBeGreaterThan(3590_000)

    let header = signWithKeys(await keysFor(t, ep.id), "msg_1", "{}", new Date())
    expect(verifies(r.endpoint.secret!, header)).toBe(true)
    expect(verifies(ep.secret!, header)).toBe(true)

    const revoked = await store.revokePreviousSecrets(t, ep.id)
    expect(revoked!.previous_secrets).toEqual([])
    header = signWithKeys(await keysFor(t, ep.id), "msg_1", "{}", new Date())
    expect(verifies(ep.secret!, header)).toBe(false)
  })

  it("stops signing with a retiring key the moment it expires", async () => {
    const t = await workspace()
    const ep = await create(t)
    await store.rotateSecret(t, ep.id, { action: "expire", expiresInSeconds: 3600 })
    // Age the stored expiry into the past without touching anything else.
    await owner`update core.webhook_endpoints
                   set retiring_secrets = jsonb_set(retiring_secrets, '{0,expiresAt}', to_jsonb((now() - interval '1 second')::text))
                 where id = ${ep.id}`
    expect(await keysFor(t, ep.id)).toHaveLength(1)
    const listed = (await store.list(t)).find((e) => e.id === ep.id)!
    expect(listed.previous_secrets).toEqual([])
  })

  it("never stores a secret in clear", async () => {
    const t = await workspace()
    const ep = await create(t)
    await store.rotateSecret(t, ep.id, { action: "expire", expiresInSeconds: 600 })
    const [row] =
      await owner`select secret_ciphertext, retiring_secrets::text as r from core.webhook_endpoints where id = ${ep.id}`
    expect(row!.secret_ciphertext).not.toContain("whsec_")
    expect(row!.r).not.toContain("whsec_")
    expect(row!.r).not.toContain(ep.secret!)
  })

  it("caps live keys at three", async () => {
    const t = await workspace()
    const ep = await create(t)
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await store.rotateSecret(t, ep.id, {
            action: "expire",
            expiresInSeconds: 600,
          })
        ).status,
      ).toBe("rotated")
    }
    const third = await store.rotateSecret(t, ep.id, {
      action: "expire",
      expiresInSeconds: 600,
    })
    expect(third.status).toBe("rejected")
    expect((await keysFor(t, ep.id)).length).toBe(3)
  })

  // ⚠ THE LOCK IN rotateSecret IS WHAT THIS PROVES. Without it, two rotations
  // each read an empty retiring list and each write back one entry, and one
  // customer-chosen grace period silently disappears.
  it("keeps both retiring keys when two rotations race", async () => {
    const t = await workspace()
    const ep = await create(t)
    // Hold the row so both rotations are in flight before either can write;
    // without that the race depends on scheduling and proves nothing.
    let racing!: Promise<Awaited<ReturnType<WebhookEndpointStore["rotateSecret"]>>[]>
    await owner.begin(async (tx) => {
      await tx`select 1 from core.webhook_endpoints where id = ${ep.id} for update`
      racing = Promise.all([
        store.rotateSecret(t, ep.id, { action: "expire", expiresInSeconds: 600 }),
        store.rotateSecret(t, ep.id, { action: "expire", expiresInSeconds: 600 }),
      ])
      await Bun.sleep(300)
    })
    const results = await racing
    expect(results.map((r) => r.status)).toEqual(["rotated", "rotated"])
    const listed = (await store.list(t)).find((e) => e.id === ep.id)!
    expect(listed.previous_secrets).toHaveLength(2)
  })

  it("ed25519: no secret is shown, the public key verifies, and switching schemes works", async () => {
    const t = await workspace()
    const ep = await create(t, "ed25519")
    expect(ep.secret).toBeNull()
    expect(ep.public_key!.startsWith("whpk_")).toBe(true)
    const ts = String(Math.floor(Date.now() / 1000))
    let header = signWithKeys(await keysFor(t, ep.id), "msg_1", "{}", new Date())
    expect(verifyEd25519(ep.public_key!, "msg_1", ts, "{}", header)).toBe(true)

    const r = await store.rotateSecret(
      t,
      ep.id,
      { action: "expire", expiresInSeconds: 600 },
      "hmac_sha256",
    )
    if (r.status !== "rotated") throw new Error(r.status)
    expect(r.endpoint.signature_scheme).toBe("hmac_sha256")
    expect(r.endpoint.public_key).toBeNull()
    header = signWithKeys(await keysFor(t, ep.id), "msg_1", "{}", new Date())
    expect(verifies(r.endpoint.secret!, header)).toBe(true)
    expect(verifyEd25519(ep.public_key!, "msg_1", ts, "{}", header)).toBe(true)
  })

  it("cannot rotate another workspace's endpoint", async () => {
    const mine = await workspace()
    const theirs = await workspace()
    const ep = await create(theirs)
    expect((await store.rotateSecret(mine, ep.id, { action: "revoke" })).status).toBe(
      "not_found",
    )
    expect(await store.revokePreviousSecrets(mine, ep.id)).toBeNull()
  })
})
