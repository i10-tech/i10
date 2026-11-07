import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { withTenant, type Database } from "../src/db/client.js"
import * as schema from "../src/db/schema.js"
import { directoryMailStore } from "../src/identity/mail-store.js"
import { joinStore } from "../src/console/join.js"
import { mirrorRequiredDomains } from "../src/identity/authd-mirror.js"
import { identityStore } from "../src/identity/store.js"
import { secretBox } from "../src/webhooks/signing.js"
import { mailRevocation } from "../src/mailboxes/revoke.js"
import { mailAccess } from "../src/mailboxes/store.js"
import { raiseCredentialEpoch } from "../src/projection/credential-epoch.js"
import { applyClerkEvent } from "../src/projection/writer.js"

/**
 * Every way a mail login ends that the account row alone can say, against a real
 * database as `i10_api`: what is written to `authd.accounts` (the columns authd
 * reads ahead of its credential cache) for each of the gaps in
 * mailboxes/revoke.ts, and that none of them reaches another workspace.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:<pw>@localhost:<port>/i10 bun test test/mail-signin-gaps-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let sqlApi: ReturnType<typeof postgres>
let db: Database

const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const sfx = acme.slice(0, 8)
const acmeDomain = `acme-${sfx}.test`
const rivalDomain = `rival-${sfx}.test`
const movedDomain = `moved-${sfx}.test`
const ada = `user_ada${sfx}`
const grace = `user_grace${sfx}`
const bob = `user_bob${sfx}`
const carl = `user_carl${sfx}`
const dora = `user_dora${sfx}`
const conn = crypto.randomUUID()
const at = new Date("2026-11-07T10:00:00Z")
const ids = [ada, grace, bob, carl, dora]

type Row = {
  active: boolean
  suspended_at: Date | null
  payment_hold_at: Date | null
  credential_epoch: string
  banned: boolean
  locked: boolean
  locked_until: Date | null
}

suite("closing the mail sign-in gaps", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    sqlApi = postgres(API_URL!, { max: 4, onnotice: () => {} })
    db = drizzle(sqlApi, { schema }) as unknown as Database
    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const)
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`g-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_${id.slice(0, 8)}`})`
    // Hosted, verified domains: what `core.mailbox_domains()` reads.
    for (const [tenant, name] of [
      [acme, acmeDomain],
      [rival, rivalDomain],
      // Moved: the rival holds it NOW, while the account below still says acme.
      [rival, movedDomain],
    ] as const)
      await owner`insert into core.domains (tenant_id, name, hosts_mailboxes, verified_at, status)
                  values (${tenant}, ${name}, true, now(), 'verified')`
    await owner`insert into identity.connections (id, tenant_id, name, protocol, status, enforcement)
                values (${conn}, ${acme}, 'Okta', 'saml', 'active', 'off')`
  })

  afterAll(async () => {
    await owner`delete from authd.accounts where clerk_user_id = any(${ids})`
    await owner`delete from core.tenants where id in (${acme}, ${rival})`
    await owner.end()
    await sqlApi.end()
  })

  const seed = async () => {
    await owner`delete from authd.accounts where clerk_user_id = any(${ids})`
    for (const [id, email, tenant] of [
      [ada, `ada@${acmeDomain}`, acme],
      [grace, `grace@${acmeDomain}`, null], // from before `tenant_id` was filled in
      [bob, `bob@${rivalDomain}`, rival],
      [carl, `carl@${movedDomain}`, acme], // STALE: the domain moved to the rival
      [dora, `dora@${acmeDomain}`, acme],
    ] as const)
      await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                  values (${id}, ${email}, true, ${tenant})`
  }
  const row = async (id: string) =>
    (
      await owner`select active, suspended_at, payment_hold_at, credential_epoch,
                         banned, locked, locked_until
                    from authd.accounts where clerk_user_id = ${id}`
    )[0] as unknown as Row

  /** The leaver policy's suspension, as a spy: who it was asked to suspend. */
  const spy = () => {
    const asked: string[] = []
    return {
      asked,
      lifecycle: {
        suspend: async (input: { clerkUserId: string }) => {
          asked.push(input.clerkUserId)
          return "suspended" as const
        },
      },
    }
  }
  const revocation = (over: { member?: boolean; managed?: boolean } = {}) => {
    const leaver = spy()
    return {
      leaver,
      ...mailRevocation({
        db,
        mail: directoryMailStore(db),
        isMember: async () => over.member ?? false,
        managedHere: async () => over.managed ?? false,
        leaver: () => leaver.lifecycle,
        record: async () => {},
        log: { info() {}, warn() {}, error() {} },
        now: () => at,
      }),
    }
  }

  // ── 1. A member who leaves ────────────────────────────────────────────────

  it("1: a member removed from a workspace loses the login of THEIR mailbox in it, and only it", async () => {
    await seed()
    const rev = revocation()
    expect(await rev.memberLeft(acme, ada, "membership_removed")).toBe("suspended")
    expect((await row(ada)).suspended_at).not.toBeNull()
    // Kept: still active, so it still receives, and its mail is not touched.
    expect((await row(ada)).active).toBe(true)
    // Somebody else's mailbox in the same workspace.
    expect((await row(dora)).suspended_at).toBeNull()
    // A person is in several workspaces and holds ONE mailbox: leaving the rival
    // (where ada has none) must not touch the one she has on acme's domain.
    await owner`update authd.accounts set suspended_at = null where clerk_user_id = ${ada}`
    expect(await rev.memberLeft(rival, ada, "membership_removed")).toBe("no_mailbox")
    expect((await row(ada)).suspended_at).toBeNull()
  })

  it("1: a mailbox whose tenant_id was never filled in is still found by its domain", async () => {
    await seed()
    expect(await revocation().memberLeft(acme, grace, "membership_removed")).toBe(
      "suspended",
    )
    expect((await row(grace)).suspended_at).not.toBeNull()
  })

  it("1: leaving again is idempotent, and re-adding the member does not resume", async () => {
    await seed()
    const rev = revocation()
    await rev.memberLeft(acme, ada, "membership_removed")
    const first = (await row(ada)).suspended_at
    expect(await rev.memberLeft(acme, ada, "membership_removed")).toBe("already")
    expect((await row(ada)).suspended_at).toEqual(first)
    // Re-adding is a membership event; nothing in this module resumes, and the
    // only writer of `suspended_at = null` is the owner's / directory's resume.
    const back = revocation({ member: true })
    expect(await back.memberLeft(acme, ada, "membership_removed")).toBe("still_member")
    expect((await row(ada)).suspended_at).not.toBeNull()
  })

  it("1: a person the workspace manages is suspended by the leaver policy, not a second plan", async () => {
    await seed()
    const rev = revocation({ managed: true })
    await rev.memberLeft(acme, ada, "membership_removed")
    expect(rev.leaver.asked).toEqual([ada])
    // And the plain KEEP path is not also taken: the row is the policy's to write.
    expect((await row(ada)).suspended_at).toBeNull()
  })

  // ── 2. A workspace deleted or terminated ─────────────────────────────────

  it("2: a deleted workspace has every mailbox of its own suspended, and none of anyone else's", async () => {
    await seed()
    const done = await mailAccess.suspendWorkspace(db, acme, at)
    expect(done.sort()).toEqual([ada, dora, grace].sort())
    expect((await row(ada)).active).toBe(true)
    expect((await row(grace)).suspended_at).not.toBeNull() // tenant_id was null
    expect((await row(bob)).suspended_at).toBeNull() // the rival's
    // ⚠ STALE tenant_id: the domain moved to the rival, so it is NOT acme's.
    expect((await row(carl)).suspended_at).toBeNull()
    // Idempotent: a redelivered termination suspends nobody twice.
    expect(await mailAccess.suspendWorkspace(db, acme, at)).toEqual([])
  })

  // ── 3. A domain removed ──────────────────────────────────────────────────

  it("3: removing a domain suspends the accounts on it and drops the aliases on it, nothing else", async () => {
    await seed()
    // Dora's primary is on a kept domain, with an alias on the one being removed
    // and another on a kept one; ada is on the removed domain with an alias too.
    await owner`insert into authd.aliases (address, clerk_user_id, source) values
      (${`d2@${acmeDomain}`}, ${dora}, 'clerk'),
      (${`dora@${rivalDomain}`}, ${dora}, 'clerk')`
    await owner`delete from authd.aliases where address = ${`d2@${acmeDomain}`}`
    const rev = revocation()
    const out = await rev.domainGone(acme, rivalDomain)
    // The rival's domain: not acme's to touch, so acme removing a name it does not
    // host changes nothing, even where dora holds an alias on it.
    expect(out).toEqual({ suspended: 0, aliases: 0 })
    expect(
      (
        await owner`select 1 from authd.aliases where address = ${`dora@${rivalDomain}`}`
      ).length,
    ).toBe(1)
    await owner`delete from authd.aliases where address = ${`dora@${rivalDomain}`}`

    await owner`insert into authd.aliases (address, clerk_user_id, source) values
      (${`ada.alt@${acmeDomain}`}, ${dora}, 'clerk')`
    const gone = await rev.domainGone(acme, acmeDomain)
    // ada, grace (tenant_id null on a name acme hosts) and dora are on it.
    expect(gone.suspended).toBe(3)
    expect(gone.aliases).toBe(1)
    for (const id of [ada, grace, dora])
      expect((await row(id)).suspended_at).not.toBeNull()
    expect((await row(bob)).suspended_at).toBeNull()
    expect((await row(carl)).suspended_at).toBeNull()
    expect(
      (
        await owner`select 1 from authd.aliases where address = ${`ada.alt@${acmeDomain}`}`
      ).length,
    ).toBe(0)
  })

  // ── 4. Non-payment ───────────────────────────────────────────────────────

  it("4: a lapsed plan holds the logins, keeps delivery, and paying lifts only the hold", async () => {
    await seed()
    // dora is suspended by a person leaving: payment must not give that back.
    await owner`update authd.accounts set suspended_at = ${at} where clerk_user_id = ${dora}`
    expect(await mailAccess.hold(db, acme, at)).toBe(3)
    for (const id of [ada, grace, dora]) {
      expect((await row(id)).payment_hold_at).not.toBeNull()
      expect((await row(id)).active).toBe(true)
    }
    expect((await row(bob)).payment_hold_at).toBeNull()
    expect((await row(carl)).payment_hold_at).toBeNull()
    expect(await mailAccess.hold(db, acme, at)).toBe(0) // idempotent

    expect(await mailAccess.release(db, acme)).toBe(3)
    expect((await row(ada)).payment_hold_at).toBeNull()
    expect((await row(dora)).suspended_at).not.toBeNull()
  })

  // ── 5. SSO required ─────────────────────────────────────────────────────

  describe("5: authd.required_domains follows what the connections say", () => {
    const names = async () =>
      (
        await owner`select domain from authd.required_domains where tenant_id = ${acme} order by domain`
      ).map((r) => r.domain as string)
    // As in production: inside the workspace's own transaction, so row level
    // security scopes every read to it.
    const mirror = (tenant = acme) =>
      withTenant(db, tenant, (tx) => mirrorRequiredDomains(tx, tenant))
    const proof = async (name: string) => {
      const [p] = await owner`insert into core.join_domains
        (tenant_id, name, clerk_org_id, source, verified_at)
        values (${acme}, ${name}, ${`org_${sfx}`}, 'txt', now()) returning id`
      await owner`insert into identity.connection_domains (connection_id, join_domain_id, tenant_id)
                  values (${conn}, ${p!.id}, ${acme})`
      return p!.id as string
    }
    const setConnection = (status: string, enforcement: string) =>
      owner`update identity.connections set status = ${status}, enforcement = ${enforcement}
             where id = ${conn}`

    it("is empty until an ACTIVE connection requires it", async () => {
      await owner`delete from core.join_domains where tenant_id = ${acme}`
      await proof(`sso-${sfx}.test`)
      await mirror()
      expect(await names()).toEqual([])
      await setConnection("active", "optional")
      await mirror()
      expect(await names()).toEqual([])
    })

    it("holds the connection's live domains while it requires SSO, in either mode", async () => {
      for (const mode of ["required_domain", "required_all"]) {
        await setConnection("active", mode)
        await mirror()
        expect(await names()).toEqual([`sso-${sfx}.test`])
      }
    })

    it("lets go of them when it is disabled, loosened, or its proof lapses or is displaced", async () => {
      await setConnection("disabled", "required_all")
      await mirror()
      expect(await names()).toEqual([])
      await setConnection("active", "required_all")
      await mirror()
      expect(await names()).toEqual([`sso-${sfx}.test`])
      await owner`update core.join_domains set lapsed_at = now() where tenant_id = ${acme}`
      await mirror()
      expect(await names()).toEqual([])
      await owner`update core.join_domains set lapsed_at = null where tenant_id = ${acme}`
      await mirror()
      expect(await names()).toEqual([`sso-${sfx}.test`])
      await owner`update core.join_domains set displaced_at = now() where tenant_id = ${acme}`
      await mirror()
      expect(await names()).toEqual([])
      await setConnection("active", "off")
    })

    it("the row is the workspace's own: another workspace's recompute leaves it alone", async () => {
      await owner`update core.join_domains set displaced_at = null where tenant_id = ${acme}`
      await setConnection("active", "required_domain")
      await mirror()
      await mirror(rival)
      expect(await names()).toEqual([`sso-${sfx}.test`])
      await setConnection("active", "off")
      await mirror()
    })
  })

  // The same, through the entry points production uses: nothing here calls the
  // mirror itself, so a mutator that stopped calling it fails these.
  describe("5: and the real mutators move it", () => {
    const store = () => identityStore(db, secretBox("ab".repeat(32)))
    const names = async (tenant: string) =>
      (
        await owner`select domain from authd.required_domains where tenant_id = ${tenant} order by domain`
      ).map((r) => r.domain as string)
    let connectionId = ""
    let proofId = ""
    const name = `real-${sfx}.test`

    it("attaching a domain to a connection that already requires SSO covers it at once", async () => {
      const made = await store().createConnection(acme, {
        name: "Real",
        protocol: "test",
        provider: "generic",
        createdBy: "user_owner",
      })
      connectionId = made.id
      await owner`update identity.connections set status = 'active', enforcement = 'required_domain'
                   where id = ${connectionId}`
      const [p] = await owner`insert into core.join_domains
        (tenant_id, name, clerk_org_id, source, verified_at)
        values (${acme}, ${name}, ${`org_${sfx}`}, 'txt', now()) returning id`
      proofId = p!.id as string
      expect(await store().addDomain(acme, connectionId, proofId)).toBe("added")
      expect(await names(acme)).toEqual([name])
    })

    it("changing enforcement or status through updateConnection moves it, both ways", async () => {
      await store().updateConnection(acme, connectionId, { enforcement: "optional" })
      expect(await names(acme)).toEqual([])
      await store().updateConnection(acme, connectionId, {
        enforcement: "required_all",
      })
      expect(await names(acme)).toEqual([name])
      await store().updateConnection(acme, connectionId, { status: "disabled" })
      expect(await names(acme)).toEqual([])
      await store().updateConnection(acme, connectionId, { status: "active" })
      expect(await names(acme)).toEqual([name])
    })

    it("detaching the domain, or deleting its proof, lets go of it", async () => {
      expect(await store().removeDomain(acme, connectionId, proofId)).toBe(true)
      expect(await names(acme)).toEqual([])
      expect(await store().addDomain(acme, connectionId, proofId)).toBe("added")
      expect(await names(acme)).toEqual([name])
      expect(await joinStore(db).removeAccessDomain(acme, proofId)).toBe(true)
      expect(await names(acme)).toEqual([])
    })

    it("a proof another workspace takes over stops being required here", async () => {
      const [p] = await owner`insert into core.join_domains
        (tenant_id, name, clerk_org_id, source, verified_at)
        values (${acme}, ${name}, ${`org_${sfx}`}, 'txt', now()) returning id`
      await store().addDomain(acme, connectionId, p!.id as string)
      expect(await names(acme)).toEqual([name])
      // The rival proves the same name; latest proof wins, so acme's is displaced.
      await owner`insert into core.join_domains (tenant_id, name, clerk_org_id, source, token)
                  values (${rival}, ${name}, ${`org_r${sfx}`}, 'txt', 'tok')`
      const lookup = async () => [`"i10-access=tok"`]
      const [theirs] = await owner`select id from core.join_domains
                                    where tenant_id = ${rival} and name = ${name}`
      expect(await joinStore(db).verifyTxt(rival, theirs!.id as string, lookup)).toBe(
        "proven",
      )
      expect(await names(acme)).toEqual([])
      // ⚠ AND THE RIVAL'S OWN PROOF IS NOT ACME'S REQUIREMENT: authd must not lock out
      // the new owner's people because of a connection acme once had.
      expect(await names(rival)).toEqual([])
    })
  })

  // ── 7. Clerk ban and lock ───────────────────────────────────────────────

  describe("7: Clerk's ban and lock reach the row", () => {
    // Clerk's `updated_at` only ever moves forward, and the projection refuses an
    // older one, so every event here is a millisecond after the last.
    let clock = Date.UTC(2026, 10, 7, 12, 0, 0)
    const event = (_id: string, over: Record<string, unknown>) => ({
      id: ada,
      updated_at: ++clock,
      email_addresses: [
        {
          id: "idn_1",
          email_address: `ada@${acmeDomain}`,
          verification: { status: "verified" },
        },
      ],
      primary_email_address_id: "idn_1",
      ...over,
    })
    const apply = (id: string, over: Record<string, unknown>) =>
      applyClerkEvent(
        db,
        `evt_${id}_${crypto.randomUUID()}`,
        "user.updated",
        event(id, over),
        [acmeDomain],
      )

    it("a ban and a lock are projected, with a lockout's own end, and lifted again", async () => {
      await seed()
      await apply("a", { banned: true })
      expect(await row(ada)).toMatchObject({ banned: true, locked: false })
      await apply("bb", {
        banned: false,
        locked: true,
        lockout_expires_in_seconds: 3599,
      })
      const locked = await row(ada)
      expect(locked).toMatchObject({ banned: false, locked: true })
      expect(locked.locked_until!.getTime()).toBeGreaterThan(Date.now() + 3000_000)
      await apply("ccc", { banned: false, locked: false })
      expect(await row(ada)).toMatchObject({
        banned: false,
        locked: false,
        locked_until: null,
      })
    })

    it("an older delivery cannot lift a ban a newer one set", async () => {
      await seed()
      await apply("dddd", { banned: true })
      await applyClerkEvent(
        db,
        `evt_old_${crypto.randomUUID()}`,
        "user.updated",
        { ...event("x", { banned: false }), updated_at: Date.UTC(2026, 0, 1) },
        [acmeDomain],
      )
      expect((await row(ada)).banned).toBe(true)
    })

    // ⚠ A PAYLOAD THAT DID NOT CARRY THE FIELDS MUST NOT LIFT A BAN: only an explicit
    // false does, or a webhook shape that dropped them would fail open.
    it("a payload without the fields leaves a ban and a lock as they were", async () => {
      await seed()
      await apply("ffffff", { banned: true })
      await applyClerkEvent(
        db,
        `evt_bare_${crypto.randomUUID()}`,
        "user.updated",
        event("gggggggg", {}),
        [acmeDomain],
      )
      expect((await row(ada)).banned).toBe(true)
      await apply("hhhhhhhhh", { locked: true })
      await applyClerkEvent(
        db,
        `evt_bare2_${crypto.randomUUID()}`,
        "user.updated",
        event("iiiiiiiiii", {}),
        [acmeDomain],
      )
      expect(await row(ada)).toMatchObject({ banned: true, locked: true })
    })

    it("a profile edit never lifts a suspension or a payment hold", async () => {
      await seed()
      await owner`update authd.accounts set suspended_at = ${at}, payment_hold_at = ${at}
                   where clerk_user_id = ${ada}`
      await apply("eeeee", {})
      expect(await row(ada)).toMatchObject({ banned: false })
      expect((await row(ada)).suspended_at).not.toBeNull()
      expect((await row(ada)).payment_hold_at).not.toBeNull()
    })
  })

  // ── 9. The epoch never repeats ──────────────────────────────────────────

  it("9: a row made again starts above anything its predecessor reached", async () => {
    await seed()
    for (let i = 0; i < 5; i++) await raiseCredentialEpoch(db, ada)
    const before = BigInt((await row(ada)).credential_epoch)
    // Seeded from the clock, in microseconds: far above any small counter.
    expect(before).toBeGreaterThan(1_000_000_000_000_000n)

    // The mailbox is deleted and made again (an address given up and taken back).
    await owner`delete from authd.accounts where clerk_user_id = ${ada}`
    await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                values (${ada}, ${`ada@${acmeDomain}`}, true, ${acme})`
    const after = BigInt((await row(ada)).credential_epoch)
    expect(after).toBeGreaterThan(before)
    // Raising still only ever adds.
    await raiseCredentialEpoch(db, ada)
    expect(BigInt((await row(ada)).credential_epoch)).toBe(after + 1n)
  })
})
