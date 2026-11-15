import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createCipheriv, randomBytes } from "node:crypto"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { resealSecrets, type ColumnReport } from "../scripts/reseal-secrets.js"
import { keyringFromEnv } from "../src/crypto/keyring.js"
import { sealer, sealedUnder } from "../src/crypto/sealer.js"
import type { Database } from "../src/db/client.js"
import { dnsConnectionStore } from "../src/dns/connections.js"
import { webhookDeliveryOps } from "../src/webhooks/db.js"

/**
 * The re-seal job against a real database: v1 values become v2 under the
 * current key, the application then opens them for the same rows, a rerun
 * changes nothing, a rotation moves them to the new key, and a value on the
 * wrong row is reported rather than rewritten.
 *
 *   WEBHOOKS_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/i10 bun test test/reseal-secrets-db.test.ts
 *
 * ⚠ THE JOB WALKS EVERY ROW IN THE DATABASE, other test files' included, so
 * these assert on this file's own rows and never on whole-table counts.
 */
const URL = process.env.WEBHOOKS_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const legacyKey = Buffer.alloc(32, 0x5a)
const key = (kid: string, fill: number) =>
  `${kid}:${Buffer.alloc(32, fill).toString("base64")}`
const k1 = sealer(keyringFromEnv("SEAL_KEYS", key("k1", 1)), legacyKey.toString("hex"))
const k2 = sealer(keyringFromEnv("SEAL_KEYS", `${key("k2", 2)},${key("k1", 1)}`))
const noLegacy = sealer(keyringFromEnv("SEAL_KEYS", key("k1", 1)))

/** A value in the old format, as `WEBHOOK_SECRET_KEY` sealed it. */
function legacySeal(plaintext: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", legacyKey, iv)
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return [
    "v1",
    ...[iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")),
  ].join(".")
}

let owner: ReturnType<typeof postgres>
let app: ReturnType<typeof postgres>
let db: Database
const tenants: string[] = []

async function workspace() {
  const id = crypto.randomUUID()
  await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
              values (${id}, ${`t-${id.slice(0, 8)}`}, 'T', ${`reseal-test-${id}`})`
  tenants.push(id)
  return id
}

/** An SQS endpoint and a DNS connection, every secret in the v1 format. */
async function legacyRows(tenantId: string) {
  const [endpoint] = await owner`
    insert into core.webhook_endpoints
      (tenant_id, kind, url, secret_ciphertext, events, aws_access_key_id, aws_secret_ciphertext, retiring_secrets)
    values (${tenantId}, 'sqs', 'https://sqs.eu-central-1.amazonaws.com/000000000000/q',
            ${legacySeal("signing-current")}, '{email.sent}', 'AKIDTEST',
            ${legacySeal("aws-secret")},
            ${owner.json([{ ciphertext: legacySeal("signing-old"), scheme: "hmac_sha256", expiresAt: "2999-01-01T00:00:00Z" }] as never)})
    returning id`
  await owner`
    insert into core.dns_connections (tenant_id, provider, credential_sealed)
    values (${tenantId}, 'cloudflare', ${legacySeal(JSON.stringify({ kind: "token", token: "dns-token" }))})`
  return endpoint!.id as string
}

async function storedValues(endpointId: string, tenantId: string) {
  const [e] =
    await owner`select secret_ciphertext, aws_secret_ciphertext, retiring_secrets
                            from core.webhook_endpoints where id = ${endpointId}`
  const [d] =
    await owner`select credential_sealed from core.dns_connections where tenant_id = ${tenantId}`
  return [
    e!.secret_ciphertext as string,
    e!.aws_secret_ciphertext as string,
    ...(e!.retiring_secrets as { ciphertext: string }[]).map((r) => r.ciphertext),
    d!.credential_sealed as string,
  ]
}

/** What the application opens for these rows, through its own read paths. */
async function appView(sealing: typeof k1, tenantId: string, endpointId: string) {
  const [d] =
    await owner`insert into core.webhook_deliveries (tenant_id, endpoint_id, event_type, occurred_at, payload)
                          values (${tenantId}, ${endpointId}, 'email.sent', now(), '{}') returning id`
  const loaded = await webhookDeliveryOps({ db, secrets: sealing }).load({
    deliveryId: d!.id,
    endpointId,
    tenantId,
  })
  const dns = await dnsConnectionStore(db, sealing, { error: () => {} }).get(
    tenantId,
    "cloudflare",
  )
  return {
    keys: loaded!.keys.map((k) => k.secret),
    aws: loaded!.sqs?.secretAccessKey,
    dns: dns?.credential,
  }
}

const failedIn = (reports: ColumnReport[], id: string) =>
  reports.filter((r) => r.failed.some((f) => f.rowId === id)).map((r) => r.purpose)

suite("re-sealing every sealed column", () => {
  beforeAll(() => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    app = postgres(API_URL!, { max: 2, onnotice: () => {} })
    db = drizzle({ client: app }) as unknown as Database
  })
  afterAll(async () => {
    if (tenants.length) await owner`delete from core.tenants where id = any(${tenants})`
    await owner.end()
    await app.end()
  })

  it("dry run counts and writes nothing", async () => {
    const t = await workspace()
    const endpoint = await legacyRows(t)
    const before = await storedValues(endpoint, t)

    const reports = await resealSecrets(owner, k1, { apply: false })

    expect(await storedValues(endpoint, t)).toEqual(before)
    expect(
      reports.find((r) => r.purpose === "core.webhook_endpoints.retiring_secrets")!.v1,
    ).toBeGreaterThanOrEqual(1)
    expect(failedIn(reports, endpoint)).toEqual([])
  })

  it("moves v1 to v2 under the current key, for the rows the application reads", async () => {
    const t = await workspace()
    const endpoint = await legacyRows(t)

    await resealSecrets(owner, k1, { apply: true })

    for (const value of await storedValues(endpoint, t)) {
      expect(sealedUnder(value)).toEqual({ version: "v2", kid: "k1" })
    }
    // Opened without the legacy key: these are v2 values bound to their rows.
    expect(await appView(noLegacy, t, endpoint)).toEqual({
      keys: ["signing-current", "signing-old"],
      aws: "aws-secret",
      dns: { kind: "token", token: "dns-token" },
    })

    // A second run finds nothing stale and rewrites nothing.
    const after = await storedValues(endpoint, t)
    await resealSecrets(owner, k1, { apply: true })
    expect(await storedValues(endpoint, t)).toEqual(after)
  })

  it("is the rotation tool: a new key first moves every value onto it", async () => {
    const t = await workspace()
    const endpoint = await legacyRows(t)
    await resealSecrets(owner, k1, { apply: true })

    const reports = await resealSecrets(owner, k2, { apply: true })

    for (const value of await storedValues(endpoint, t)) {
      expect(sealedUnder(value)).toEqual({ version: "v2", kid: "k2" })
    }
    expect(failedIn(reports, endpoint)).toEqual([])
    expect((await appView(k2, t, endpoint)).aws).toBe("aws-secret")
  })

  it("reports a value copied onto another row by id, and leaves it as it is", async () => {
    const t = await workspace()
    const source = await legacyRows(t)
    await resealSecrets(owner, k1, { apply: true })
    const [target] = await owner`
      insert into core.webhook_endpoints (tenant_id, url, secret_ciphertext, events)
      select tenant_id, 'https://hooks.example.com/x', secret_ciphertext, '{email.sent}'
        from core.webhook_endpoints where id = ${source}
      returning id, secret_ciphertext`

    const reports = await resealSecrets(owner, k2, { apply: true })

    expect(failedIn(reports, target!.id)).toEqual([
      "core.webhook_endpoints.secret_ciphertext",
    ])
    const [still] =
      await owner`select secret_ciphertext from core.webhook_endpoints where id = ${target!.id}`
    expect(still!.secret_ciphertext).toBe(target!.secret_ciphertext)
  })

  it("reports v1 values as failed when the legacy key is not configured", async () => {
    const t = await workspace()
    const endpoint = await legacyRows(t)

    const reports = await resealSecrets(owner, noLegacy, { apply: true })

    expect(failedIn(reports, endpoint)).toEqual([
      "core.webhook_endpoints.secret_ciphertext",
      "core.webhook_endpoints.retiring_secrets",
      "core.webhook_endpoints.aws_secret_ciphertext",
    ])
    expect(sealedUnder((await storedValues(endpoint, t))[0]!)).toEqual({
      version: "v1",
    })
  })

  it("a DNS credential that will not open reads as disconnected, and says so in the log", async () => {
    const t = await workspace()
    await legacyRows(t)
    const errors: object[] = []
    const log = { error: (o: object) => void errors.push(o) }

    const connection = await dnsConnectionStore(db, noLegacy, log).get(t, "cloudflare")

    expect(connection).toBeNull()
    expect(errors).toMatchObject([{ tenantId: t, provider: "cloudflare" }])
  })

  it("refuses to run as a role that row level security filters", async () => {
    await resealSecrets(app, k1, { apply: false }).then(
      () => {
        throw new Error("expected a refusal")
      },
      (error: Error) => expect(error.message).toContain("cannot see every row"),
    )
  })
})
