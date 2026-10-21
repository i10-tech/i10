import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { identityStore } from "../src/identity/store.js"
import { samlStore } from "../src/identity/saml-store.js"
import { secretBox } from "../src/webhooks/signing.js"
import { keys } from "./saml-idp.js"

/**
 * The SAML tables against a real database as `i10_api` (#339): certificates
 * by tenant, the five-certificate limit, metadata replacement leaving uploads
 * alone, the logout lookups, and the definer the daily pass reads.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/<scratch> bun test test/identity-saml-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const box = secretBox("ab".repeat(32))
const certs = [keys(2048, "a"), keys(2048, "b"), keys(2048, "c")]
const upload = (i: number) => ({ ...certs[i]!.cert, source: "upload" as const })

suite("SAML tables", () => {
  let connectionId = ""
  let draftId = ""
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`s-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
    const store = identityStore(database, box)
    const made = await store.createConnection(acme, {
      name: "Acme SAML",
      protocol: "saml",
      provider: "okta",
      createdBy: "u",
    })
    connectionId = made.id
    await store.updateConnection(acme, connectionId, { status: "testing" })
    draftId = (
      await store.createConnection(acme, {
        name: "draft",
        protocol: "saml",
        provider: "okta",
        createdBy: "u",
      })
    ).id
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  const saml = () => samlStore(database)

  it("adds certificates per connection, once each, never into another workspace", async () => {
    expect(await saml().addCertificate(acme, connectionId, upload(0), "u")).toBe(
      "added",
    )
    expect(await saml().addCertificate(acme, connectionId, upload(0), "u")).toBe(
      "exists",
    )
    expect(
      (await saml().certificates(acme, connectionId)).map((c) => c.fingerprint),
    ).toEqual([certs[0]!.cert.fingerprint])
    expect(await saml().certificates(rival, connectionId)).toEqual([])
    // The composite foreign key: Rival cannot hang a row on Acme's connection.
    await expect(
      saml().addCertificate(rival, connectionId, upload(1), "u"),
    ).rejects.toThrow()
  })

  it("replaces only metadata certificates, in one go", async () => {
    let done = await saml().replaceMetadataCertificates(acme, connectionId, [
      certs[1]!.cert,
    ])
    expect(done).toEqual({ added: [certs[1]!.cert.fingerprint], removed: [] })
    done = await saml().replaceMetadataCertificates(acme, connectionId, [
      certs[2]!.cert,
    ])
    expect(done).toEqual({
      added: [certs[2]!.cert.fingerprint],
      removed: [certs[1]!.cert.fingerprint],
    })
    const rows = await saml().certificates(acme, connectionId)
    expect(rows.map((r) => [r.fingerprint, r.source]).sort()).toEqual(
      [
        [certs[0]!.cert.fingerprint, "upload"],
        [certs[2]!.cert.fingerprint, "metadata"],
      ].sort(),
    )
  })

  it("holds at most five", async () => {
    for (let i = 0; i < 3; i++)
      await saml().addCertificate(
        acme,
        connectionId,
        { ...keys(2048, `x${i}`).cert, source: "upload" },
        "u",
      )
    expect(await saml().addCertificate(acme, connectionId, upload(1), "u")).toBe(
      "limit",
    )
  })

  it("notes alerts and removes a certificate", async () => {
    const [first] = await saml().certificates(acme, connectionId)
    await saml().noteAlert(acme, first!.id, 7)
    expect((await saml().certificates(acme, connectionId))[0]!.alertedDays).toBe(7)
    expect(await saml().removeCertificate(rival, connectionId, first!.id)).toBe(false)
    expect(await saml().removeCertificate(acme, connectionId, first!.id)).toBe(true)
  })

  it("finds the sessions a LogoutRequest names", async () => {
    const store = identityStore(database, box)
    const identity = await store.link(acme, {
      connectionId,
      subject: "persistent:00u-ada",
      clerkUserId: "user_ada_s",
      email: "ada@acme.test",
    })
    for (const [sid, idx] of [
      ["sess_s1", "_i1"],
      ["sess_s2", "_i2"],
    ] as const)
      await store.bindSession(acme, {
        sessionId: `${sid}${acme.slice(0, 6)}`,
        clerkUserId: "user_ada_s",
        connectionId,
        identityId: identity.id,
        idpSession: idx,
        authTime: new Date(),
        at: new Date(),
        freshAt: new Date(),
      })
    const all = await saml().sessionsForLogout(acme, connectionId, {
      subject: "persistent:00u-ada",
      sessionIndexes: [],
    })
    expect(all).toHaveLength(2)
    const one = await saml().sessionsForLogout(acme, connectionId, {
      subject: null,
      sessionIndexes: ["_i2"],
    })
    expect(one.map((s) => s.sessionId)).toEqual([`sess_s2${acme.slice(0, 6)}`])
    expect(
      await saml().sessionsForLogout(acme, connectionId, {
        subject: null,
        sessionIndexes: [],
      }),
    ).toEqual([])
    expect(
      await saml().sessionsForLogout(rival, connectionId, {
        subject: "persistent:00u-ada",
        sessionIndexes: [],
      }),
    ).toEqual([])
    expect(await saml().boundSession(acme, `sess_s1${acme.slice(0, 6)}`)).toMatchObject(
      {
        subject: "persistent:00u-ada",
        idpSession: "_i1",
      },
    )
  })

  it("lists SAML connections across workspaces through the definer, drafts left out", async () => {
    const seen: string[] = []
    let after: string | null = null
    for (;;) {
      const page = await saml().dueConnections(after, 50)
      if (!page.length) break
      seen.push(...page.map((p) => p.id))
      after = page.at(-1)!.id
    }
    expect(seen).toContain(connectionId)
    expect(seen).not.toContain(draftId)
  })
})
