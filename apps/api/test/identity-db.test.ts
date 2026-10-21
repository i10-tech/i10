import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { assertRlsSubject, type Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { identityStore } from "../src/identity/store.js"
import { hashSecret } from "../src/identity/model.js"
import { secretBox } from "../src/webhooks/signing.js"

/**
 * The identity schema against a real database as `i10_api` (#337): every
 * outsider read is a row-level-security policy, and only Postgres can say each
 * one admits exactly the rows its value names and nothing else.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/identity-db.test.ts
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
const live = `acme-${suffix}.test`
const displaced = `old-${suffix}.test`
let liveProof = ""
let displacedProof = ""
const ada = `user_ada_${suffix}`
const box = secretBox("ab".repeat(32))

suite("identity schema", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle(db, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`i-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
    const [a] =
      await owner`insert into core.join_domains (tenant_id, name, clerk_org_id, source, verified_at)
                            values (${acme}, ${live}, 'org_a', 'txt', now()) returning id`
    const [b] =
      await owner`insert into core.join_domains (tenant_id, name, clerk_org_id, source, verified_at, displaced_at)
                            values (${acme}, ${displaced}, 'org_a', 'txt', now(), now()) returning id`
    liveProof = a!.id as string
    displacedProof = b!.id as string
  })
  afterAll(async () => {
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await db.end()
  })

  const store = () => identityStore(database, box)

  it("keeps the boot check passing with the new schema", async () => {
    await assertRlsSubject(db)
  })

  let connectionId = ""
  it("covers only live proofs of the workspace, and each proof once", async () => {
    const made = await store().createConnection(acme, {
      name: "Acme",
      protocol: "test",
      provider: "generic",
      createdBy: "user_owner",
    })
    connectionId = made.id
    expect(made.status).toBe("draft")
    expect(await store().addDomain(acme, connectionId, liveProof)).toBe("added")
    expect(await store().addDomain(acme, connectionId, liveProof)).toBe("added")
    expect(await store().addDomain(acme, connectionId, displacedProof)).toBe(
      "not_found",
    )
    // Another workspace cannot name Acme's proof.
    expect(await store().addDomain(rival, connectionId, liveProof)).toBe("not_found")
    const second = await store().createConnection(acme, {
      name: "B",
      protocol: "test",
      provider: "generic",
      createdBy: "u",
    })
    expect(await store().addDomain(acme, second.id, liveProof)).toBe("taken")
    expect(await store().liveDomains(acme, connectionId)).toEqual([live])
  })

  it("stops counting a domain the moment its proof is displaced", async () => {
    await owner`update core.join_domains set displaced_at = now() where id = ${liveProof}`
    expect(await store().liveDomains(acme, connectionId)).toEqual([])
    const [listed] = await store().connections(acme)
    expect(listed!.domains).toEqual([
      { joinDomainId: liveProof, name: live, live: false },
    ])
    await owner`update core.join_domains set displaced_at = null where id = ${liveProof}`
    expect(await store().liveDomains(acme, connectionId)).toEqual([live])
  })

  it("refuses, in the database itself, a row that points at another workspace's connection or proof", async () => {
    // As the owner, so no policy is in the way: only the composite keys are.
    // ⚠ AWAITED INSIDE: a postgres.js query is lazy, and `.rejects` alone
    // never runs it (the test then hangs).
    const refusal = async (run: () => Promise<unknown>) => {
      try {
        await run()
        return "accepted"
      } catch (error) {
        return String(error)
      }
    }
    expect(
      await refusal(
        () => owner`insert into identity.identities (tenant_id, connection_id, subject, clerk_user_id)
                    values (${rival}, ${connectionId}, 'x', 'user_x')`,
      ),
    ).toMatch(/identities_connection_fk/)
    const [theirs] =
      await owner`insert into identity.connections (tenant_id, name, protocol)
                                 values (${rival}, 'R', 'test') returning id`
    expect(
      await refusal(
        () => owner`insert into identity.connection_domains (tenant_id, connection_id, join_domain_id)
                    values (${rival}, ${theirs!.id}, ${displacedProof})`,
      ),
    ).toMatch(/connection_domains_proof_fk/)
    await owner`delete from identity.connections where id = ${theirs!.id}`
  })

  it("keeps the audit log append only, even for its own workspace", async () => {
    await store().record(acme, { type: "test.event", reason: "kept" })
    const changed = await database.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${acme}, true)`)
      const updated = await tx.execute(
        sql`update identity.events set reason = 'rewritten' where tenant_id = ${acme}::uuid returning id`,
      )
      const deleted = await tx.execute(
        sql`delete from identity.events where tenant_id = ${acme}::uuid returning id`,
      )
      return [...updated, ...deleted].length
    })
    expect(changed).toBe(0)
    const rows = await store().events(acme, { limit: 50 })
    expect(rows.some((r) => r.reason === "kept")).toBe(true)
    expect(rows.some((r) => r.reason === "rewritten")).toBe(false)
  })

  it("reads a connection by id with no workspace, and never another workspace's through its own", async () => {
    expect((await store().connectionForStart(connectionId))?.tenantId).toBe(acme)
    expect(await store().connectionForStart("not-a-uuid")).toBeNull()
    expect(await store().connection(rival, connectionId)).toBeNull()
    expect(await store().connections(rival)).toEqual([])
  })

  it("spends an attempt's state, code and secret once each, read only by their own hash", async () => {
    const state = "s".repeat(43)
    const { id } = await store().createAttempt({
      tenantId: acme,
      connectionId,
      purpose: "sign_in",
      stateHash: hashSecret(state),
      bindingHash: hashSecret("b".repeat(43)),
      pkceVerifier: "verifier-in-the-clear",
      expiresAt: new Date(Date.now() + 600_000),
    })
    const [raw] =
      await owner`select pkce_verifier from identity.login_attempts where id = ${id}`
    expect(String(raw!.pkce_verifier).startsWith("v1.")).toBe(true)
    const read = await store().attemptByState(hashSecret(state))
    expect(read).toMatchObject({
      id,
      tenantId: acme,
      pkceVerifier: "verifier-in-the-clear",
    })
    expect(await store().attemptByState(hashSecret("t".repeat(43)))).toBeNull()

    expect(await store().consumeAttempt(acme, id, new Date())).toBe(true)
    expect(await store().consumeAttempt(acme, id, new Date())).toBe(false)
    expect(await store().consumeAttempt(rival, id, new Date())).toBe(false)

    await store().finishAttempt(acme, id, {
      outcome: "signed_in",
      clerkUserId: ada,
      handoffCodeHash: hashSecret("c".repeat(43)),
      handoffExpiresAt: new Date(Date.now() + 120_000),
    })
    expect(
      (await store().attemptByHandoffCode(hashSecret("c".repeat(43))))?.clerkUserId,
    ).toBe(ada)
    expect(await store().claimRedeem(acme, id, new Date())).toBe(true)
    expect(await store().claimRedeem(acme, id, new Date())).toBe(false)
    await store().recordToken(acme, id, {
      signInTokenId: "sit_1",
      mintedAt: new Date(),
      handoffSecretHash: hashSecret("h".repeat(43)),
    })
    expect(
      (await store().attemptByHandoffSecret(hashSecret("h".repeat(43))))?.signInTokenId,
    ).toBe("sit_1")
    expect(await store().markBound(acme, id, "sess_1", new Date())).toBe(true)
    expect(await store().markBound(acme, id, "sess_1", new Date())).toBe(false)
  })

  it("makes an account managed by one workspace only, readable by the user and by its addresses", async () => {
    const row = {
      clerkUserId: ada,
      tenantId: acme,
      connectionId,
      reason: "claimed" as const,
      emails: [`ada@${live}`],
    }
    expect(await store().claimManaged(acme, row)).toBe("created")
    expect(await store().claimManaged(acme, row)).toBe("kept")
    expect(await store().claimManaged(rival, { ...row, tenantId: rival })).toBe(
      "elsewhere",
    )
    expect((await store().managedByUser(ada))?.tenantId).toBe(acme)
    expect(await store().managedByUser("user_nobody")).toBeNull()
    expect(await store().managedByIdentifier(`ada@${live}`)).toBe(true)
    expect(await store().managedByIdentifier(`ADA@${live}`)).toBe(true)
    expect(await store().managedByIdentifier(`eve@${live}`)).toBe(false)
    // Another workspace can neither see nor release it.
    expect(await store().releaseManaged(rival, ada)).toBe(false)
  })

  it("answers the gate in one read: unmanaged, unbound, bound with its connection", async () => {
    expect(await store().gateRead("user_nobody", "sess_x")).toEqual({ managed: null })
    expect(await store().gateRead(ada, "sess_unbound")).toEqual({
      managed: { tenantId: acme, connectionId },
      session: null,
    })
    const at = new Date()
    await store().bindSession(acme, {
      sessionId: `sess_${suffix}`,
      clerkUserId: ada,
      connectionId,
      identityId: null,
      idpSession: "idp-1",
      authTime: at,
      at,
      freshAt: at,
    })
    const read = await store().gateRead(ada, `sess_${suffix}`)
    expect(read).toMatchObject({
      managed: { tenantId: acme },
      session: {
        sessionId: `sess_${suffix}`,
        connectionStatus: "draft",
        domainLive: true,
        revokedAt: null,
      },
    })
    // A displaced proof takes the bound session's domain with it.
    await owner`update core.join_domains set displaced_at = now() where id = ${liveProof}`
    expect((await store().gateRead(ada, `sess_${suffix}`)) as unknown).toMatchObject({
      session: { domainLive: false },
    })
    await owner`update core.join_domains set displaced_at = null where id = ${liveProof}`
    // Somebody else asking about Ada's session sees nothing of it.
    expect(await store().gateRead("user_eve", `sess_${suffix}`)).toEqual({
      managed: null,
    })
    expect(
      await store().revokeSessionRow(acme, `sess_${suffix}`, "admin", new Date()),
    ).toBe(true)
    expect(
      await store().revokeSessionRow(acme, `sess_${suffix}`, "admin", new Date()),
    ).toBe(false)
    expect(await store().sessionsOf(acme, ada)).toEqual([])
  })

  it("keeps every table behind the tenant boundary for a direct query", async () => {
    const seen = await db.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${rival}, true)`
      return {
        connections: await tx`select id from identity.connections`,
        managed: await tx`select clerk_user_id from identity.managed_accounts`,
        sessions: await tx`select session_id from identity.sso_sessions`,
        attempts: await tx`select id from identity.login_attempts`,
      }
    })
    expect(seen.connections).toHaveLength(0)
    expect(seen.managed).toHaveLength(0)
    expect(seen.sessions).toHaveLength(0)
    expect(seen.attempts).toHaveLength(0)
  })

  it("writes and reads the audit log and the deprovisioning setting", async () => {
    expect(await store().deprovisionMode(acme)).toBe("membership")
    await store().setDeprovisionMode(acme, "account", "user_owner")
    expect(await store().deprovisionMode(acme)).toBe("account")
    expect(await store().deprovisionMode(rival)).toBe("membership")
    await store().record(acme, {
      type: "connection.created",
      actorUserId: "user_owner",
      connectionId,
    })
    const [event] = await store().events(acme, { limit: 10 })
    expect(event).toMatchObject({
      type: "connection.created",
      actorUserId: "user_owner",
    })
    expect(await store().events(rival, { limit: 10 })).toEqual([])
  })

  it("seals a connection's secrets at rest and opens them only for its workspace (#338)", async () => {
    expect(await store().connectionSecrets(acme, connectionId)).toEqual({})
    const written = await store().setConnectionSecrets(acme, connectionId, () => ({
      secrets: { oidc: { clientSecret: "client-secret-at-rest" } },
      config: { oidc: { clientSecretSet: true } },
    }))
    expect(written?.config).toEqual({ oidc: { clientSecretSet: true } })
    const [row] =
      await owner`select secrets, config from identity.connections where id = ${connectionId}`
    expect(String(row!.secrets)).toStartWith("v1.")
    expect(String(row!.secrets)).not.toContain("client-secret-at-rest")
    expect(await store().connectionSecrets(acme, connectionId)).toEqual({
      oidc: { clientSecret: "client-secret-at-rest" },
    })
    expect(await store().connectionSecrets(rival, connectionId)).toBeNull()
    expect(
      await store().setConnectionSecrets(rival, connectionId, () => ({
        secrets: { oidc: {} },
        config: {},
      })),
    ).toBeNull()
    // The connection as every other read returns it carries no secret.
    expect(JSON.stringify(await store().connection(acme, connectionId))).not.toContain(
      "client-secret-at-rest",
    )
  })

  it("forgets a deleted user's links and managed row", async () => {
    await store().link(acme, {
      connectionId,
      subject: "okta|ada",
      clerkUserId: ada,
      email: null,
    })
    await store().forgetUser(acme, ada)
    expect(await store().identityBySubject(acme, connectionId, "okta|ada")).toBeNull()
    expect(await store().managedByUser(ada)).toBeNull()
  })

  // ── #341: group rules, the JIT lock, what an SSO domain covers ──

  const refusal = async (run: () => Promise<unknown>) => {
    try {
      await run()
      return "accepted"
    } catch (error) {
      return String(error)
    }
  }

  it("keeps group rules per connection, ordered, unique by group and capped (#341)", async () => {
    const mine = await store().createConnection(acme, {
      name: "Rules",
      protocol: "test",
      provider: "generic",
      createdBy: "u",
    })
    try {
      const admin = await store().createGroupRule(acme, {
        connectionId: mine.id,
        groupValue: "eng-admins",
        role: "admin",
        precedence: 20,
        createdBy: "user_owner",
      })
      const staff = await store().createGroupRule(acme, {
        connectionId: mine.id,
        groupValue: "staff",
        role: "member",
        precedence: 5,
        createdBy: "user_owner",
      })
      if (typeof admin === "string" || typeof staff === "string")
        throw new Error("rules were not created")
      expect(admin).toMatchObject({
        groupValue: "eng-admins",
        role: "admin",
        precedence: 20,
      })
      expect(
        (await store().groupRules(acme, mine.id)).map((r) => r.groupValue),
      ).toEqual(["staff", "eng-admins"])
      // One rule per group, in the database itself.
      expect(
        await store().createGroupRule(acme, {
          connectionId: mine.id,
          groupValue: "staff",
          role: "admin",
          precedence: 1,
          createdBy: "u",
        }),
      ).toBe("exists")
      expect(
        await store().updateGroupRule(acme, mine.id, admin.id, { groupValue: "staff" }),
      ).toBe("exists")
      expect(
        await store().updateGroupRule(acme, mine.id, admin.id, {
          precedence: 1,
          role: "member",
        }),
      ).toMatchObject({ groupValue: "eng-admins", precedence: 1, role: "member" })
      // A tie goes to the older rule (uuidv7 ids sort by creation).
      await store().updateGroupRule(acme, mine.id, staff.id, { precedence: 1 })
      expect(
        (await store().groupRules(acme, mine.id)).map((r) => r.groupValue),
      ).toEqual(["eng-admins", "staff"])
      // The wrong connection or an unknown rule is not found.
      expect(
        await store().updateGroupRule(acme, connectionId, admin.id, { precedence: 2 }),
      ).toBeNull()
      expect(await store().deleteGroupRule(acme, connectionId, admin.id)).toBeNull()
      expect(
        await store().deleteGroupRule(acme, mine.id, crypto.randomUUID()),
      ).toBeNull()

      // The cap is 100; two creations racing for the last place get one place.
      for (let i = 0; i < 97; i++)
        await owner`insert into identity.group_role_rules (tenant_id, connection_id, group_value, role, precedence)
                    values (${acme}, ${mine.id}, ${`filler-${i}`}, 'member', ${i})`
      const racing = await Promise.all(
        ["last-a", "last-b"].map((groupValue) =>
          store().createGroupRule(acme, {
            connectionId: mine.id,
            groupValue,
            role: "member",
            precedence: 1,
            createdBy: "u",
          }),
        ),
      )
      expect(racing.filter((r) => typeof r !== "string")).toHaveLength(1)
      expect(racing.filter((r) => r === "too_many")).toHaveLength(1)
      expect(await store().groupRules(acme, mine.id)).toHaveLength(100)

      expect(await store().deleteGroupRule(acme, mine.id, staff.id)).toMatchObject({
        groupValue: "staff",
      })
      expect(await store().groupRules(acme, mine.id)).toHaveLength(99)
    } finally {
      // Rules go with their connection (cascade); nothing is left behind.
      await owner`delete from identity.connections where id = ${mine.id}`
    }
    const [left] =
      await owner`select count(*)::int as n from identity.group_role_rules where connection_id = ${mine.id}`
    expect(left!.n).toBe(0)
  })

  it("hides group rules from another workspace and refuses a cross-workspace row (#341)", async () => {
    const mine = await store().createConnection(acme, {
      name: "Rules RLS",
      protocol: "test",
      provider: "generic",
      createdBy: "u",
    })
    try {
      const made = await store().createGroupRule(acme, {
        connectionId: mine.id,
        groupValue: "secret-group",
        role: "admin",
        precedence: 1,
        createdBy: "u",
      })
      if (typeof made === "string") throw new Error("rule was not created")
      // The rival names Acme's connection and rule and gets nothing, changes nothing.
      expect(await store().groupRules(rival, mine.id)).toEqual([])
      expect(
        await store().createGroupRule(rival, {
          connectionId: mine.id,
          groupValue: "planted",
          role: "admin",
          precedence: 1,
          createdBy: "u",
        }),
      ).toBe("not_found")
      expect(
        await store().updateGroupRule(rival, mine.id, made.id, { role: "member" }),
      ).toBeNull()
      expect(await store().deleteGroupRule(rival, mine.id, made.id)).toBeNull()
      expect(await store().groupRules(acme, mine.id)).toMatchObject([
        { groupValue: "secret-group", role: "admin" },
      ])
      // A direct query as the rival sees no rule at all.
      const seen = await db.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${rival}, true)`
        return tx`select id from identity.group_role_rules`
      })
      expect(seen).toHaveLength(0)
      // As the owner, with no policy in the way, the composite key still refuses it.
      expect(
        await refusal(
          () => owner`insert into identity.group_role_rules (tenant_id, connection_id, group_value, role, precedence)
                      values (${rival}, ${mine.id}, 'x', 'admin', 1)`,
        ),
      ).toMatch(/group_role_rules_connection_fk/)
    } finally {
      await owner`delete from identity.connections where id = ${mine.id}`
    }
  })

  it("refuses an owner role and an out-of-range precedence in the table itself (#341)", async () => {
    const mine = await store().createConnection(acme, {
      name: "Rules checks",
      protocol: "test",
      provider: "generic",
      createdBy: "u",
    })
    try {
      const insert = (role: string, precedence: number) => () =>
        owner`insert into identity.group_role_rules (tenant_id, connection_id, group_value, role, precedence)
              values (${acme}, ${mine.id}, ${`g-${role}-${precedence}`}, ${role}, ${precedence})`
      expect(await refusal(insert("owner", 1))).toMatch(/group_role_rules_role_check/)
      expect(await refusal(insert("", 1))).toMatch(/group_role_rules_role_check/)
      expect(await refusal(insert("member", -1))).toMatch(
        /group_role_rules_precedence_check/,
      )
      expect(await refusal(insert("member", 10_001))).toMatch(
        /group_role_rules_precedence_check/,
      )
      expect(await refusal(insert("admin", 10_000))).toBe("accepted")
      // And the update path: a patch cannot smuggle owner past the store either.
      const [rule] = await store().groupRules(acme, mine.id)
      // (Drizzle wraps the driver's error; the constraint is in its cause.)
      const smuggled = await store()
        .updateGroupRule(acme, mine.id, rule!.id, { role: "owner" as never })
        .then(
          () => "accepted",
          (error: { cause?: unknown }) => String(error.cause),
        )
      expect(smuggled).toMatch(/group_role_rules_role_check/)
      expect((await store().groupRules(acme, mine.id))[0]).toMatchObject({
        role: "admin",
      })
    } finally {
      await owner`delete from identity.connections where id = ${mine.id}`
    }
  })

  it("serialises provisioning per address, across connections, and links in the lock's transaction (#341)", async () => {
    const mine = await store().createConnection(acme, {
      name: "JIT lock",
      protocol: "test",
      provider: "generic",
      createdBy: "u",
    })
    const key = { connectionId: mine.id, email: `grace@${live}` }
    const order: string[] = []
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
    try {
      const run = async (name: string, subject: string, userId: string) =>
        store().provisionLocked(acme, key, async (lock) => {
          order.push(`${name}:in`)
          const found = await lock.identityBySubject(subject)
          // Long enough for the other call to be waiting on the lock.
          await pause(150)
          if (found) {
            order.push(`${name}:found`)
            return found.clerkUserId
          }
          await lock.link({ subject, clerkUserId: userId, email: key.email })
          order.push(`${name}:linked`)
          return userId
        })
      const results = await Promise.all([
        run("a", "okta|grace", "user_jit_a"),
        run("b", "okta|grace", "user_jit_b"),
      ])
      // One got in first and linked; the other waited, then SAW that link.
      const winner = order[0]!.split(":")[0]!
      const loser = winner === "a" ? "b" : "a"
      expect(order).toEqual([
        `${winner}:in`,
        `${winner}:linked`,
        `${loser}:in`,
        `${loser}:found`,
      ])
      expect(results[0]).toBe(results[1]!)
      expect(
        await store().identityBySubject(acme, mine.id, "okta|grace"),
      ).toMatchObject({ clerkUserId: results[0] })

      // A different address does not wait for this one.
      const t0 = Date.now()
      await Promise.all([
        store().provisionLocked(acme, key, async () => pause(200)),
        store().provisionLocked(
          acme,
          { connectionId: mine.id, email: `ada@${live}` },
          async () => pause(200),
        ),
      ])
      expect(Date.now() - t0).toBeLessThan(380)

      // The same address through ANOTHER connection does wait: the lock is
      // the address's, which is what Clerk makes unique.
      const t1 = Date.now()
      await Promise.all([
        store().provisionLocked(acme, key, async () => pause(200)),
        store().provisionLocked(
          acme,
          { connectionId: crypto.randomUUID(), email: key.email },
          async () => pause(200),
        ),
      ])
      expect(Date.now() - t1).toBeGreaterThanOrEqual(400)

      // A failure inside the lock rolls the link back: nobody is half-linked.
      await expect(
        store().provisionLocked(acme, key, async (lock) => {
          await lock.link({
            subject: "okta|rolled",
            clerkUserId: "user_x",
            email: key.email,
          })
          throw new Error("clerk went away")
        }),
      ).rejects.toThrow("clerk went away")
      expect(await store().identityBySubject(acme, mine.id, "okta|rolled")).toBeNull()
    } finally {
      await owner`delete from identity.connections where id = ${mine.id}`
    }
  })

  it("reads the workspace's name and the names an active connection covers (#341)", async () => {
    expect(await store().workspaceName(acme)).toBe("Acme")
    expect(await store().workspaceName(rival)).toBe("Rival")
    expect(await store().workspaceName(crypto.randomUUID())).toBeNull()

    // `connectionId` holds the live proof and is still a draft here.
    expect(await store().coveredDomains(acme)).toEqual([])
    try {
      await store().updateConnection(acme, connectionId, { status: "testing" })
      expect(await store().coveredDomains(acme)).toEqual([])
      await store().updateConnection(acme, connectionId, { status: "active" })
      expect(await store().coveredDomains(acme)).toEqual([live])
      // Another workspace is covered by nothing of Acme's.
      expect(await store().coveredDomains(rival)).toEqual([])
      // A displaced proof no longer covers anyone.
      await owner`update core.join_domains set displaced_at = now() where id = ${liveProof}`
      expect(await store().coveredDomains(acme)).toEqual([])
      await owner`update core.join_domains set displaced_at = null where id = ${liveProof}`
      expect(await store().coveredDomains(acme)).toEqual([live])
      await store().updateConnection(acme, connectionId, { status: "disabled" })
      expect(await store().coveredDomains(acme)).toEqual([])
    } finally {
      await store().updateConnection(acme, connectionId, { status: "draft" })
    }
    expect(await store().coveredDomains(acme)).toEqual([])
  })
})
