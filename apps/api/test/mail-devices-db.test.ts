import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import { Hono } from "hono"
import postgres from "postgres"
import { withTenant, type Database } from "../src/db/client.js"
import { directoryMailStore } from "../src/identity/mail-store.js"
import { mailboxLifecycle } from "../src/identity/directory-mail.js"
import {
  mirrorPassthrough,
  mirrorRequiredDomains,
} from "../src/identity/authd-mirror.js"
import { mintHookSecret } from "../src/identity/okta-event-hook.js"
import { backchannelLogout } from "../src/identity/oidc-logout.js"
import { oidcEngine } from "../src/identity/oidc.js"
import { guardedFetch } from "../src/identity/oidc-fetch.js"
import { fixedWindow } from "../src/identity/rate-limit.js"
import { finishSlo, samlEngine } from "../src/identity/saml.js"
import { samlStore } from "../src/identity/saml-store.js"
import { identityStore } from "../src/identity/store.js"
import { universalLogout } from "../src/identity/universal-logout.js"
import {
  MailDeviceError,
  matchesDeviceCode,
  parseDeviceCode,
  parseMailDeviceCodeKeys,
} from "../src/mail-devices/code.js"
import { pruneMailDevices } from "../src/mail-devices/prune.js"
import {
  endFor,
  listDevices,
  mint,
  raiseConnectionEpochAndEndDevices,
  raiseEpochAndEndDevices,
  revoke,
} from "../src/mail-devices/store.js"
import { mailboxAdminLifecycle } from "../src/mailboxes/lifecycle.js"
import { mailboxLifecycleStore } from "../src/mailboxes/lifecycle-store.js"
import { mailRevocation } from "../src/mailboxes/revoke.js"
import { mailAccess } from "../src/mailboxes/store.js"
import { raiseConnectionCredentialEpochs } from "../src/projection/connection-epoch.js"
import { raiseCredentialEpoch } from "../src/projection/credential-epoch.js"
import { applyClerkEvent } from "../src/projection/writer.js"
import { createOktaEventHooks } from "../src/routes/okta-event-hooks.js"
import type { EgressVerdict } from "../src/webhooks/egress.js"
import { log, memoryClerk, memoryReplay } from "./identity-fakes.js"
import { testIssuer } from "./oidc-issuer.js"
import { keys as samlKeys } from "./saml-idp.js"
import { testSealer } from "./support/sealer.js"
import { createSign } from "node:crypto"
import { deflateRawSync } from "node:zlib"
import { SignJWT } from "jose"

/**
 * End-to-end Postgres tests for `authd.mail_devices` (#383, section 10):
 *   - store module (`mint`, `list`, `revoke`, `endFor`) + gate refusals + tenant boundary
 *   - every revocation path in section 10's table
 *   - holds keeping device rows intact
 *   - FK cascade on account deletion
 *   - hourly `pruneMailDevices` (unused > 10m, idle > 90d, batched loop)
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/i10 bun test test/mail-devices-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const TEST_KEYS = parseMailDeviceCodeKeys(
  "1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=,7:gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6v",
)
const PUBLIC: EgressVerdict = { ok: true, address: "93.184.216.34", family: 4 }

let owner: ReturnType<typeof postgres>
let sqlApi: ReturnType<typeof postgres>
let db: Database

const acme = crypto.randomUUID()
const rival = crypto.randomUUID()
const sfx = acme.slice(0, 8)
const acmeDomain = `acme-${sfx}.test`
const acmeSecondDomain = `acme2-${sfx}.test`
const rivalDomain = `rival-${sfx}.test`

const ada = `user_md_ada_${sfx}`
const bob = `user_md_bob_${sfx}`
const grace = `user_md_grace_${sfx}`
const rivalAda = `user_md_rival_${sfx}`
const systemUser = `user_md_sys_${sfx}`
const allUsers = [ada, bob, grace, rivalAda, systemUser]

const box = testSealer()
const at = new Date("2026-11-24T10:00:00Z")
const KEEP = {
  next: "keep" as const,
  targetUserId: null,
  targetAddress: null,
  days: null,
  deleteAt: null,
}

suite("mail device store and revocation paths against Postgres", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    sqlApi = postgres(API_URL!, { max: 4, onnotice: () => {} })
    db = drizzle({ client: sqlApi }) as unknown as Database

    for (const [id, name] of [
      [acme, "Acme"],
      [rival, "Rival"],
    ] as const) {
      await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
                  values (${id}, ${`md-${id.slice(0, 8)}`}, ${name}, ${`owner-${id}`}, ${`org_md_${id.slice(0, 8)}`})`
    }
    for (const [tenant, name] of [
      [acme, acmeDomain],
      [acme, acmeSecondDomain],
      [rival, rivalDomain],
    ] as const) {
      await owner`insert into core.domains (tenant_id, name, hosts_mailboxes, verified_at, status)
                  values (${tenant}, ${name}, true, now(), 'verified')`
    }
  })

  afterAll(async () => {
    try {
      await owner`delete from authd.mail_devices where clerk_user_id = any(${allUsers})`
      await owner`delete from authd.accounts where clerk_user_id = any(${allUsers})`
      await owner`delete from authd.webhook_events where event_id like ${`md_${sfx}_%`}`
      await owner`delete from core.tenants where id in (${acme}, ${rival})`
    } finally {
      await owner.end()
      await sqlApi.end()
    }
  })

  const epochOf = async (userId: string) =>
    Number(
      (
        await owner`select credential_epoch from authd.accounts where clerk_user_id = ${userId}`
      )[0]!.credential_epoch,
    )

  const deviceIds = async (userId: string) =>
    (
      await owner`select id::text as id from authd.mail_devices where clerk_user_id = ${userId} order by id`
    ).map((r) => r.id as string)

  const workspaceDevices = async (tenantId: string, clerkUserId?: string) =>
    (
      await listDevices(db, {
        scope: { kind: "workspace", tenantId, ...(clerkUserId ? { clerkUserId } : {}) },
        limit: 100,
      })
    ).devices
  const ownDevices = async (clerkUserId: string) =>
    (await listDevices(db, { scope: { kind: "own", clerkUserId }, limit: 100 })).devices
  const revokeIn = async (tenantId: string, deviceId: string) =>
    (await revoke(db, { deviceId, scope: { kind: "workspace", tenantId } })) !== null
  const revokeOwn = async (clerkUserId: string, deviceId: string) =>
    (await revoke(db, { deviceId, scope: { kind: "own", clerkUserId } })) !== null

  const seedAccounts = async () => {
    await owner`delete from authd.mail_devices where clerk_user_id = any(${allUsers})`
    await owner`delete from authd.managed_accounts where clerk_user_id = any(${allUsers})`
    await owner`delete from identity.managed_accounts where clerk_user_id = any(${allUsers})`
    await owner`delete from authd.required_exempt where clerk_user_id = any(${allUsers})`
    await owner`delete from authd.required_domains where tenant_id in (${acme}, ${rival})`
    await owner`delete from identity.directory_mailboxes where tenant_id in (${acme}, ${rival})`
    await owner`delete from authd.accounts where clerk_user_id = any(${allUsers})`
    await owner`update core.domains set hosts_mailboxes = true where tenant_id in (${acme}, ${rival})`

    for (const [id, email, tenant] of [
      [ada, `ada@${acmeDomain}`, acme],
      [bob, `bob@${acmeSecondDomain}`, acme],
      [grace, `grace@${acmeDomain}`, null],
      [rivalAda, `ada@${rivalDomain}`, rival],
      [systemUser, `sys@i10-${sfx}.test`, null],
    ] as const) {
      await owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
                  values (${id}, ${email}, true, ${tenant})`
    }
  }

  const mintFor = async (
    userId: string,
    tenantId: string | null,
    name = "Test iPhone",
  ) =>
    mint(db, TEST_KEYS, {
      clerkUserId: userId,
      tenantId,
      expectedEpoch: await epochOf(userId),
      platform: "ios",
      deviceName: name,
      createdBy: "test",
    })

  it("mints with DB-generated UUIDv7, checks every gate hold and tenant boundary on mint/list/revoke", async () => {
    await seedAccounts()

    const { device, code } = await mintFor(ada, acme, "Ada's iPhone")
    const parsed = parseDeviceCode(code)
    expect(parsed).not.toBeNull()
    expect(parsed!.id).toBe(device.id)
    expect(device.email).toBe(`ada@${acmeDomain}`)
    expect(device.tenantId).toBe(acme)

    // Verify stored code_hash matches Go/TS keyed hash and code_kid is highest (7).
    const [rawRow] =
      await owner`select code_hash, code_kid from authd.mail_devices where id = ${device.id}`
    expect(rawRow!.code_kid).toBe(7)
    expect(
      matchesDeviceCode(TEST_KEYS.keys.get(7)!, parsed!, rawRow!.code_hash as Buffer),
    ).toBe(true)

    // Tenant boundary on list & revoke: rival cannot see or delete acme's device.
    expect(await workspaceDevices(acme, ada)).toHaveLength(1)
    expect(await workspaceDevices(rival, ada)).toHaveLength(0)
    expect(await revokeIn(rival, device.id)).toBe(false)
    expect(await workspaceDevices(acme, ada)).toHaveLength(1)

    // Null-tenant boundary: systemUser (tenant_id = null) is isolated from acme.
    const sysDev = await mintFor(systemUser, null, "Sys iPad")
    expect(await ownDevices(systemUser)).toHaveLength(1)
    expect(await workspaceDevices(acme, systemUser)).toHaveLength(0)
    expect(await revokeIn(acme, sysDev.device.id)).toBe(false)
    expect(await revokeOwn(systemUser, sysDev.device.id)).toBe(true)

    // Mint refusals.
    const expectRefusal = async (
      fn: () => Promise<unknown>,
      codeName: MailDeviceError["code"],
    ) => {
      try {
        await fn()
        throw new Error(`Expected refusal ${codeName}`)
      } catch (err) {
        expect(err).toBeInstanceOf(MailDeviceError)
        expect((err as MailDeviceError).code).toBe(codeName)
      }
    }

    await expectRefusal(
      () =>
        mint(db, null, {
          clerkUserId: ada,
          tenantId: acme,
          expectedEpoch: 1,
          platform: "ios",
          createdBy: "test",
        }),
      "keys_not_configured",
    )
    await expectRefusal(
      () =>
        mint(db, TEST_KEYS, {
          clerkUserId: "user_missing_xxx",
          tenantId: acme,
          expectedEpoch: 0,
          platform: "ios",
          createdBy: "test",
        }),
      "account_not_found",
    )
    await expectRefusal(() => mintFor(ada, rival), "tenant_mismatch")
    await expectRefusal(() => mintFor(ada, null), "tenant_mismatch")
    await expectRefusal(
      () =>
        mint(db, TEST_KEYS, {
          clerkUserId: ada,
          tenantId: acme,
          expectedEpoch: 0,
          platform: "ios",
          createdBy: "test",
        }),
      "epoch_mismatch",
    )

    // Inactive
    await owner`update authd.accounts set active = false where clerk_user_id = ${ada}`
    await expectRefusal(() => mintFor(ada, acme), "account_inactive")
    await owner`update authd.accounts set active = true where clerk_user_id = ${ada}`

    // Suspended
    await owner`update authd.accounts set suspended_at = now() where clerk_user_id = ${ada}`
    await expectRefusal(() => mintFor(ada, acme), "mailbox_suspended")
    await owner`update authd.accounts set suspended_at = null where clerk_user_id = ${ada}`

    // Deleting
    await owner`update authd.accounts set deleting_at = now() where clerk_user_id = ${ada}`
    await expectRefusal(() => mintFor(ada, acme), "mailbox_deleting")
    await owner`update authd.accounts set deleting_at = null where clerk_user_id = ${ada}`

    // Payment hold
    await owner`update authd.accounts set payment_hold_at = now() where clerk_user_id = ${ada}`
    await expectRefusal(() => mintFor(ada, acme), "payment_hold")
    await owner`update authd.accounts set payment_hold_at = null where clerk_user_id = ${ada}`

    // Banned
    await owner`update authd.accounts set banned = true where clerk_user_id = ${ada}`
    await expectRefusal(() => mintFor(ada, acme), "account_banned")
    await owner`update authd.accounts set banned = false where clerk_user_id = ${ada}`

    // Locked (indefinite and future refused; expired lock allowed)
    await owner`update authd.accounts set locked = true, locked_until = null where clerk_user_id = ${ada}`
    await expectRefusal(() => mintFor(ada, acme), "account_locked")
    await owner`update authd.accounts set locked_until = now() + interval '1 hour' where clerk_user_id = ${ada}`
    await expectRefusal(() => mintFor(ada, acme), "account_locked")
    await owner`update authd.accounts set locked_until = now() - interval '1 minute' where clerk_user_id = ${ada}`
    const afterExpiredLock = await mintFor(ada, acme, "After Expired Lock")
    expect(await revokeIn(acme, afterExpiredLock.device.id)).toBe(true)
    await owner`update authd.accounts set locked = false, locked_until = null where clerk_user_id = ${ada}`

    // Domain not hosted
    await owner`update core.domains set hosts_mailboxes = false where tenant_id = ${acme} and name = ${acmeDomain}`
    await expectRefusal(() => mintFor(ada, acme), "domain_not_hosted")
    await owner`update core.domains set hosts_mailboxes = true where tenant_id = ${acme} and name = ${acmeDomain}`

    // Revoke works for owning tenant.
    expect(await revokeIn(acme, device.id)).toBe(true)
    expect(await revokeIn(acme, device.id)).toBe(false)
  })

  it("directoryMailStore.suspend: admin KEEP preserves devices; memberLeft/deprovision/closeMailbox delete them even when already suspended", async () => {
    await seedAccounts()
    const mailStore = directoryMailStore(db)
    const dAda = await mintFor(ada, acme)
    const dRival = await mintFor(rivalAda, rival)

    const resumeDeps = {
      store: mailStore,
      provision: async () => ({ status: "gone" as const }),
      isMember: async () => false,
      directoryActive: async () => false,
      directoryDeactivated: async () => false,
      scheduleDeletion: async () => {},
      record: async () => {},
      log,
    }
    // Admin KEEP suspend keeps devices intact (endDevices: false).
    const life = mailboxAdminLifecycle({
      store: mailboxLifecycleStore(db),
      mail: mailStore,
      resume: resumeDeps,
      isAdmin: async () => true,
      startExport: null,
      log,
    })
    expect(
      await life.suspend({
        tenantId: acme,
        address: `ada@${acmeDomain}`,
        actorId: "admin_1",
      }),
    ).toBe("suspended")
    expect(await deviceIds(ada)).toEqual([dAda.device.id])

    // Subsequent memberLeft (endDevices: true) on the ALREADY-suspended mailbox
    // MUST still delete the device BEFORE returning "already".
    const rev = mailRevocation({
      db,
      mail: mailStore,
      isMember: async () => false,
      managedHere: async () => false,
      leaver: () => mailboxLifecycle(resumeDeps),
      record: async () => {},
      log,
    })
    await rev.memberLeft(acme, ada, "removed")
    expect(await deviceIds(ada)).toEqual([])
    expect(await deviceIds(rivalAda)).toEqual([dRival.device.id])

    // Fresh mailbox suspended via directoryMailStore.suspend(..., { endDevices: true })
    // (used by deprovision, closeMailbox, SCIM, Google) deletes devices.
    await mailStore.resume(acme, ada, { type: "mailbox.resumed" })
    await mintFor(ada, acme)
    expect(await deviceIds(ada)).toHaveLength(1)
    expect(
      await mailStore.suspend(
        acme,
        ada,
        KEEP,
        at,
        { type: "mailbox.suspended" },
        { endDevices: true },
      ),
    ).toBe("suspended")
    expect(await deviceIds(ada)).toEqual([])
    expect(await deviceIds(rivalAda)).toEqual([dRival.device.id])
  })

  it("releaseManaged raises epoch and deletes mail devices in one transaction", async () => {
    await seedAccounts()
    const idStore = identityStore(db, box)
    const conn = await idStore.createConnection(acme, {
      name: "Acme OIDC",
      protocol: "oidc",
      provider: "okta",
      createdBy: "admin_1",
    })
    await idStore.claimManaged(acme, {
      clerkUserId: ada,
      tenantId: acme,
      connectionId: conn.id,
      emails: [`ada@${acmeDomain}`],
      reason: "linked",
    })
    const beforeEpoch = await epochOf(ada)
    await mintFor(ada, acme)
    const dRival = await mintFor(rivalAda, rival)

    expect(await idStore.releaseManaged(acme, ada)).toBe(true)
    expect(await epochOf(ada)).toBeGreaterThan(beforeEpoch)
    expect(await deviceIds(ada)).toEqual([])
    expect(await deviceIds(rivalAda)).toEqual([dRival.device.id])
  })

  it("suspendWorkspace and suspendDomain end devices for active AND already-suspended accounts (and legacy null-tenant rows)", async () => {
    await seedAccounts()
    await mintFor(ada, acme)
    await mintFor(bob, acme)
    await mintFor(grace, null) // legacy row with tenant_id = null on acmeDomain
    const dRival = await mintFor(rivalAda, rival)

    // Pre-suspend ada (admin KEEP) so ada already has suspended_at set.
    await owner`update authd.accounts set suspended_at = ${at.toISOString()}::timestamptz where clerk_user_id = ${ada}`
    await owner`insert into authd.aliases (address, clerk_user_id, source) values (${`sales@${acmeDomain}`}, ${ada}, 'console')`

    // suspendDomain on acmeDomain ends ada (already suspended) and grace (null tenant),
    // deletes aliases on acmeDomain, and leaves bob (acmeSecondDomain) and rivalAda intact.
    const newlyDomain = await mailAccess.suspendDomain(db, acme, acmeDomain, at, true)
    expect(newlyDomain.suspended).toEqual([grace])
    expect(newlyDomain.aliases).toEqual([`sales@${acmeDomain}`])
    expect(await deviceIds(ada)).toEqual([])
    expect(await deviceIds(grace)).toEqual([])
    expect(await deviceIds(bob)).toHaveLength(1)
    expect(await deviceIds(rivalAda)).toEqual([dRival.device.id])
    expect(
      await owner`select 1 from authd.aliases where address = ${`sales@${acmeDomain}`}`,
    ).toHaveLength(0)

    // Re-mint for ada (after clearing suspended_at) and pre-suspend bob, then suspendWorkspace.
    await owner`update authd.accounts set suspended_at = null where clerk_user_id = ${ada}`
    await mintFor(ada, acme)
    await owner`update authd.accounts set suspended_at = ${at.toISOString()}::timestamptz where clerk_user_id = ${bob}`

    const newlyWs = await mailAccess.suspendWorkspace(db, acme, at)
    expect(newlyWs).toEqual([ada])
    expect(await deviceIds(ada)).toEqual([])
    expect(await deviceIds(bob)).toEqual([])
    expect(await deviceIds(rivalAda)).toEqual([dRival.device.id])
  })

  it("Okta Universal Logout, user-wide OIDC back-channel logout, and user-wide SAML SLO raise epoch and end devices in one tx", async () => {
    await seedAccounts()
    const idStore = identityStore(db, box)
    const samlRows = samlStore(db)
    const idp = await testIssuer({ issuer: "https://idp.acme.test" })
    const clerk = memoryClerk()
    const replay = memoryReplay()

    // OIDC connection for Universal Logout + OIDC back-channel logout.
    const oidcConn = await idStore.createConnection(acme, {
      name: "Okta OIDC",
      protocol: "oidc",
      provider: "okta",
      createdBy: "admin_1",
    })
    await idStore.setConnectionSecrets(acme, oidcConn.id, (cur) => ({
      secrets: cur.secrets,
      config: {
        ...cur.config,
        oidc: {
          issuer: "https://idp.acme.test",
          clientId: "client-acme",
          clientAuth: "client_secret_basic",
          clientSecretSet: true,
        },
      },
    }))
    await owner`update identity.connections set status = 'active' where id = ${oidcConn.id}`
    await idStore.link(acme, {
      connectionId: oidcConn.id,
      subject: "00u_ada",
      clerkUserId: ada,
      email: `ada@${acmeDomain}`,
    })

    const engine = oidcEngine({
      store: idStore,
      fetch: guardedFetch({ vet: async () => PUBLIC, fetch: idp.fetch }),
      redirectUri: "https://auth.i10.localhost/sso/callback",
      google: null,
      log,
    })

    // 1) Universal Logout
    const dRival = await mintFor(rivalAda, rival)
    await mintFor(ada, acme)
    const ep1 = await epochOf(ada)
    const uLogout = universalLogout(
      {
        store: idStore,
        sessions: samlRows,
        samlStore: samlRows,
        clerk: clerk.clerk,
        replay: replay.replay,
        forget: () => {},
        raiseCredentialEpoch: (clerkUserId, tenantId) =>
          raiseEpochAndEndDevices(db, { tenantId, clerkUserId }),
        fetch: guardedFetch({ vet: async () => PUBLIC, fetch: idp.fetch }),
        log,
        endpointUrl: (id) => `https://api.i10.localhost/sso/universal-logout/${id}`,
      },
      engine,
    )
    const uToken = await new SignJWT({
      jti: crypto.randomUUID(),
      iss: "https://idp.acme.test",
      sub: "client-acme",
      aud: `https://api.i10.localhost/sso/universal-logout/${oidcConn.id}`,
      iat: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({
        alg: "RS256",
        typ: "global-token-revocation+jwt",
        kid: idp.kid,
      })
      .setExpirationTime("5m")
      .sign(idp.signing.privateKey)
    expect(
      await uLogout({
        connectionId: oidcConn.id,
        authHeader: `Bearer ${uToken}`,
        body: {
          sub_id: { format: "iss_sub", iss: "https://idp.acme.test", sub: "00u_ada" },
        },
      }),
    ).toEqual({ outcome: "logged_out", revoked: 0 })
    expect(await epochOf(ada)).toBeGreaterThan(ep1)
    expect(await deviceIds(ada)).toEqual([])
    expect(await deviceIds(rivalAda)).toEqual([dRival.device.id])

    // 2) OIDC back-channel logout: sid keeps devices; sub without sid ends devices.
    await mintFor(ada, acme)
    const bcLogout = backchannelLogout(
      {
        store: idStore,
        sessions: samlRows,
        clerk: clerk.clerk,
        replay: replay.replay,
        forget: () => {},
        raiseCredentialEpoch: (clerkUserId, tenantId) =>
          raiseEpochAndEndDevices(db, { tenantId, clerkUserId }),
        fetch: guardedFetch({ vet: async () => PUBLIC, fetch: idp.fetch }),
        log,
      },
      engine,
    )
    const sidToken = await idp.logoutToken({ sub: "00u_ada", sid: "sess-only" })
    expect(
      await bcLogout({ connectionId: oidcConn.id, logoutToken: sidToken }),
    ).toEqual({
      outcome: "logged_out",
      revoked: 0,
    })
    expect(await deviceIds(ada)).toHaveLength(1)

    const ep2 = await epochOf(ada)
    const subOnlyToken = await idp.logoutToken({ sub: "00u_ada", sid: undefined })
    expect(
      await bcLogout({ connectionId: oidcConn.id, logoutToken: subOnlyToken }),
    ).toEqual({ outcome: "logged_out", revoked: 0 })
    expect(await epochOf(ada)).toBeGreaterThan(ep2)
    expect(await deviceIds(ada)).toEqual([])

    // 3) SAML SLO: with SessionIndex keeps devices; without SessionIndex ends devices.
    const idpSaml = samlKeys(2048, "idp.acme.test")
    const samlConn = await idStore.createConnection(acme, {
      name: "Okta SAML",
      protocol: "saml",
      provider: "okta",
      createdBy: "admin_1",
    })
    await idStore.setConnectionSecrets(acme, samlConn.id, (cur) => ({
      secrets: cur.secrets,
      config: {
        ...cur.config,
        saml: {
          idpEntityId: "https://idp.acme.test/saml",
          ssoUrl: "https://idp.acme.test/sso",
          sloUrl: "https://idp.acme.test/slo",
        },
      },
    }))
    await owner`update identity.connections set status = 'active' where id = ${samlConn.id}`
    await samlRows.addCertificate(
      acme,
      samlConn.id,
      { ...idpSaml.cert, source: "upload" },
      null,
    )
    await idStore.link(acme, {
      connectionId: samlConn.id,
      subject: "persistent:00u_ada",
      clerkUserId: ada,
      email: `ada@${acmeDomain}`,
    })
    const sEngine = samlEngine({
      store: idStore,
      saml: samlRows,
      replay: replay.replay,
      fetch: guardedFetch({ vet: async () => PUBLIC }),
      authOrigin: "https://auth.i10.localhost",
      log,
    })
    const signRedirectSlo = (xml: string) => {
      const samlReq = deflateRawSync(Buffer.from(xml)).toString("base64")
      const sigAlg = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"
      const base = `SAMLRequest=${encodeURIComponent(samlReq)}&SigAlg=${encodeURIComponent(sigAlg)}`
      const sig = createSign("RSA-SHA256")
        .update(base)
        .sign(idpSaml.privateKey)
        .toString("base64")
      return `${base}&Signature=${encodeURIComponent(sig)}`
    }
    const sloXml = (id: string, sessionIndex: string | null) =>
      `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="https://auth.i10.localhost/sso/saml/slo/${samlConn.id}">` +
      `<saml:Issuer>https://idp.acme.test/saml</saml:Issuer>` +
      `<saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">00u_ada</saml:NameID>` +
      (sessionIndex ? `<samlp:SessionIndex>${sessionIndex}</samlp:SessionIndex>` : "") +
      `</samlp:LogoutRequest>`

    await mintFor(ada, acme)
    const sloDeps = {
      store: idStore,
      saml: samlRows,
      clerk: clerk.clerk,
      replay: replay.replay,
      forget: () => {},
      raiseCredentialEpoch: (clerkUserId: string, tenantId: string) =>
        raiseEpochAndEndDevices(db, { tenantId, clerkUserId }),
      log,
    }
    expect(
      await finishSlo(sloDeps, sEngine, {
        connectionId: samlConn.id,
        binding: "redirect",
        rawQuery: signRedirectSlo(sloXml("_slo_sid", "_idx1")),
      }),
    ).toMatchObject({ outcome: "logged_out", revoked: 0 })
    expect(await deviceIds(ada)).toHaveLength(1)

    const ep3 = await epochOf(ada)
    expect(
      await finishSlo(sloDeps, sEngine, {
        connectionId: samlConn.id,
        binding: "redirect",
        rawQuery: signRedirectSlo(sloXml("_slo_all", null)),
      }),
    ).toMatchObject({ outcome: "logged_out", revoked: 0 })
    expect(await epochOf(ada)).toBeGreaterThan(ep3)
    expect(await deviceIds(ada)).toEqual([])
  })

  it("Okta event hook against Postgres enforces createdBefore, event split, uuid replay, and AppInstance match", async () => {
    await seedAccounts()
    const idStore = identityStore(db, box)
    const replay = memoryReplay()
    const hook = mintHookSecret(new Date())
    const conn = await idStore.createConnection(acme, {
      name: "Okta Hook OIDC",
      protocol: "oidc",
      provider: "okta",
      createdBy: "admin_1",
    })
    await owner`update identity.connections set status = 'active' where id = ${conn.id}`
    await idStore.setConnectionSecrets(acme, conn.id, (cur) => ({
      secrets: cur.secrets,
      config: {
        ...cur.config,
        oktaEventHook: hook.stored,
        oidc: { clientId: "0oa_acme_mail" },
      },
    }))
    await idStore.link(acme, {
      connectionId: conn.id,
      subject: "00u_ada",
      clerkUserId: ada,
      email: `ada@${acmeDomain}`,
    })
    await idStore.claimManaged(acme, {
      clerkUserId: ada,
      tenantId: acme,
      connectionId: conn.id,
      emails: [`ada@${acmeDomain}`],
      reason: "linked",
    })
    await idStore.claimManaged(acme, {
      clerkUserId: bob,
      tenantId: acme,
      connectionId: conn.id,
      emails: [`bob@${acmeSecondDomain}`],
      reason: "linked",
    })

    const app = new Hono().route(
      "/webhooks",
      createOktaEventHooks({
        store: idStore,
        raiseEpoch: async (id) => {
          await raiseCredentialEpoch(db, id)
        },
        raiseConnection: async (id) => {
          await raiseConnectionCredentialEpochs(db, id)
        },
        revokeUserDevices: async (input) => {
          await raiseEpochAndEndDevices(db, input)
        },
        revokeConnectionDevices: async (input) => {
          await raiseConnectionEpochAndEndDevices(db, input)
        },
        replay: replay.replay,
        take: fixedWindow(null),
        contextSecret: undefined,
        edgeSecret: undefined,
        log,
      }),
    )
    const post = (events: unknown[]) =>
      app.request(`/webhooks/okta/${conn.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: hook.secret,
        },
        body: JSON.stringify({ data: { events } }),
      })

    const dOld = await mintFor(ada, acme, "Old iPhone")
    const dNew = await mintFor(ada, acme, "New iPhone")
    const dRival = await mintFor(rivalAda, rival)
    // Backdate dOld by 10m; leave dNew at now(). Event published 5m ago -> createdBefore = now - 4m.
    await owner`update authd.mail_devices set created_at = now() - interval '10 minutes' where id = ${dOld.device.id}`
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

    // Epoch-only event (update_password) keeps both devices.
    expect(
      (
        await post([
          {
            uuid: crypto.randomUUID(),
            published: fiveMinAgo,
            eventType: "user.account.update_password",
            outcome: { result: "SUCCESS" },
            target: [{ id: "00u_ada", type: "User", alternateId: `ada@${acmeDomain}` }],
          },
        ])
      ).status,
    ).toBe(200)
    expect(await deviceIds(ada)).toHaveLength(2)

    // Device-revoking event deletes dOld (< published + 60s) and keeps dNew (> published + 60s).
    const suspendUuid = crypto.randomUUID()
    expect(
      (
        await post([
          {
            uuid: suspendUuid,
            published: fiveMinAgo,
            eventType: "user.lifecycle.suspend",
            outcome: { result: "SUCCESS" },
            target: [{ id: "00u_ada", type: "User", alternateId: `ada@${acmeDomain}` }],
          },
        ])
      ).status,
    ).toBe(200)
    expect(await deviceIds(ada)).toEqual([dNew.device.id])
    expect(await deviceIds(rivalAda)).toEqual([dRival.device.id])

    // Replaying the same uuid (even if dNew were backdated) does NOT delete dNew.
    await owner`update authd.mail_devices set created_at = now() - interval '10 minutes' where id = ${dNew.device.id}`
    expect(
      (
        await post([
          {
            uuid: suspendUuid,
            published: fiveMinAgo,
            eventType: "user.lifecycle.suspend",
            outcome: { result: "SUCCESS" },
            target: [{ id: "00u_ada", type: "User", alternateId: `ada@${acmeDomain}` }],
          },
        ])
      ).status,
    ).toBe(200)
    expect(await deviceIds(ada)).toEqual([dNew.device.id])

    // application.lifecycle.deactivate for OWN AppInstance ends all managed devices on the connection.
    const dBob = await mintFor(bob, acme, "Bob iPad")
    expect(
      (
        await post([
          {
            uuid: crypto.randomUUID(),
            published: new Date().toISOString(),
            eventType: "application.lifecycle.deactivate",
            outcome: { result: "SUCCESS" },
            target: [{ id: "0oa_acme_mail", type: "AppInstance" }],
          },
        ])
      ).status,
    ).toBe(200)
    expect(await deviceIds(ada)).toEqual([])
    expect(await deviceIds(bob)).toEqual([])
    expect(await deviceIds(rivalAda)).toEqual([dRival.device.id])
    expect(dBob.device.id).toBeTruthy()
  })

  it("Clerk projection applyUser ends all devices on ban and mismatched devices on email or tenant change", async () => {
    await seedAccounts()
    await mintFor(ada, acme, "Ada Phone")
    const dRival = await mintFor(rivalAda, rival)

    const baseTime = Date.now() + 60_000
    const hosted = [acmeDomain, acmeSecondDomain, rivalDomain]
    // 1) Primary email rename on same domain -> device bound to old email is deleted.
    await applyClerkEvent(
      db,
      `md_${sfx}_rename`,
      "user.updated",
      {
        id: ada,
        updated_at: baseTime,
        primary_email_address_id: "em_new",
        email_addresses: [
          {
            id: "em_new",
            email_address: `ada.new@${acmeDomain}`,
            verification: { status: "verified" },
          },
        ],
      },
      hosted,
    )
    expect(await deviceIds(ada)).toEqual([])

    // 2) Mint under new email, then ban -> all devices deleted.
    await mintFor(ada, acme, "Ada Phone 2")
    expect(await deviceIds(ada)).toHaveLength(1)
    await applyClerkEvent(
      db,
      `md_${sfx}_ban`,
      "user.updated",
      {
        id: ada,
        updated_at: baseTime + 10_000,
        banned: true,
        primary_email_address_id: "em_new",
        email_addresses: [
          {
            id: "em_new",
            email_address: `ada.new@${acmeDomain}`,
            verification: { status: "verified" },
          },
        ],
      },
      hosted,
    )
    expect(await deviceIds(ada)).toEqual([])

    // 3) Unban, mint, move primary email to rivalDomain (changes tenant_id) -> device deleted.
    await applyClerkEvent(
      db,
      `md_${sfx}_unban`,
      "user.updated",
      {
        id: ada,
        updated_at: baseTime + 20_000,
        banned: false,
        primary_email_address_id: "em_new",
        email_addresses: [
          {
            id: "em_new",
            email_address: `ada.new@${acmeDomain}`,
            verification: { status: "verified" },
          },
        ],
      },
      hosted,
    )
    await mintFor(ada, acme, "Ada Phone 3")
    await applyClerkEvent(
      db,
      `md_${sfx}_move`,
      "user.updated",
      {
        id: ada,
        updated_at: baseTime + 30_000,
        primary_email_address_id: "em_rival",
        email_addresses: [
          {
            id: "em_rival",
            email_address: `ada.moved@${rivalDomain}`,
            verification: { status: "verified" },
          },
        ],
      },
      hosted,
    )
    expect(await deviceIds(ada)).toEqual([])
    expect(await deviceIds(rivalAda)).toEqual([dRival.device.id])
  })

  it("temporary holds preserve device rows and lifting them leaves the devices intact", async () => {
    await seedAccounts()
    const idStore = identityStore(db, box)
    const conn = await idStore.createConnection(acme, {
      name: "Hold OIDC",
      protocol: "oidc",
      provider: "okta",
      createdBy: "admin_1",
    })
    const { device } = await mintFor(ada, acme, "Hold Phone")

    // Apply every hold: payment hold, Clerk lock, deletion grace, domain hosting off,
    // SSO required, connection disabled, and admin KEEP suspend.
    await mailAccess.hold(db, acme, at)
    await owner`update authd.accounts set locked = true, locked_until = now() + interval '1 hour', deleting_at = now() where clerk_user_id = ${ada}`
    await owner`update core.domains set hosts_mailboxes = false where tenant_id = ${acme} and name = ${acmeDomain}`
    await owner`update identity.connections set status = 'disabled', enforcement = 'required_domain' where id = ${conn.id}`
    await withTenant(db, acme, async (tx) => {
      await mirrorRequiredDomains(tx, acme)
      await mirrorPassthrough(tx, acme)
    })
    await directoryMailStore(db).suspend(
      acme,
      ada,
      KEEP,
      at,
      { type: "mailbox.suspended" },
      { endDevices: false },
    )

    // Device row stays intact through all holds.
    expect(await deviceIds(ada)).toEqual([device.id])

    // Lift every hold -> the exact same device row is still present.
    await mailAccess.release(db, acme)
    await owner`update authd.accounts set locked = false, locked_until = null, deleting_at = null, suspended_at = null where clerk_user_id = ${ada}`
    await owner`update core.domains set hosts_mailboxes = true where tenant_id = ${acme} and name = ${acmeDomain}`
    await owner`update identity.connections set status = 'active', enforcement = 'off' where id = ${conn.id}`
    await withTenant(db, acme, async (tx) => {
      await mirrorRequiredDomains(tx, acme)
      await mirrorPassthrough(tx, acme)
    })
    expect(await deviceIds(ada)).toEqual([device.id])
  })

  it("deleting authd.accounts cascades to authd.mail_devices and leaves other accounts intact", async () => {
    await seedAccounts()
    await mintFor(ada, acme)
    const dBob = await mintFor(bob, acme)

    await owner`delete from authd.accounts where clerk_user_id = ${ada}`
    expect(await deviceIds(ada)).toEqual([])
    expect(await deviceIds(bob)).toEqual([dBob.device.id])
  })

  it("pruneMailDevices deletes unused > 10m and idle > 90d across multiple batches, keeping fresh and recent rows", async () => {
    await seedAccounts()
    const unusedExpired1 = await mintFor(ada, acme, "Unused Old 1")
    const unusedExpired2 = await mintFor(ada, acme, "Unused Old 2")
    const unusedExpired3 = await mintFor(ada, acme, "Unused Old 3")
    const unusedFresh = await mintFor(ada, acme, "Unused Fresh")
    const idleExpired1 = await mintFor(bob, acme, "Idle Old 1")
    const idleExpired2 = await mintFor(bob, acme, "Idle Old 2")
    const idleExpired3 = await mintFor(bob, acme, "Idle Old 3")
    const usedRecent = await mintFor(bob, acme, "Used Recent")

    await owner`update authd.mail_devices
                   set created_at = now() - interval '15 minutes'
                 where id in (${unusedExpired1.device.id}, ${unusedExpired2.device.id}, ${unusedExpired3.device.id})`
    await owner`update authd.mail_devices
                   set first_used_at = now() - interval '100 days',
                       last_used_at = now() - interval '91 days'
                 where id in (${idleExpired1.device.id}, ${idleExpired2.device.id}, ${idleExpired3.device.id})`
    await owner`update authd.mail_devices
                   set first_used_at = now() - interval '10 days',
                       last_used_at = now() - interval '1 day'
                 where id = ${usedRecent.device.id}`

    // batchSize: 2 forces multi-batch looping on both passes (3 rows each -> 2 + 1 = 4 batches).
    const pruned = await pruneMailDevices(db, { batchSize: 2 })
    expect(pruned).toEqual({ unused: 3, idle: 3, batches: 4 })
    expect(await deviceIds(ada)).toEqual([unusedFresh.device.id])
    expect(await deviceIds(bob)).toEqual([usedRecent.device.id])

    // Second pass with nothing expired does zero deletes.
    expect(await pruneMailDevices(db, { batchSize: 2 })).toEqual({
      unused: 0,
      idle: 0,
      batches: 0,
    })
  })

  it("mint enforces SSO route gate (sso_required, sso_exempt, managed_no_connection, connection_inactive)", async () => {
    await seedAccounts()
    const idStore = identityStore(db, box)
    const conn = await idStore.createConnection(acme, {
      name: "Acme SSO Gate",
      protocol: "oidc",
      provider: "okta",
      createdBy: "admin_1",
    })

    const expectRefusal = async (
      fn: () => Promise<unknown>,
      codeName: MailDeviceError["code"],
    ) => {
      try {
        await fn()
        throw new Error(`Expected refusal ${codeName}`)
      } catch (err) {
        expect(err).toBeInstanceOf(MailDeviceError)
        expect((err as MailDeviceError).code).toBe(codeName)
      }
    }

    // 1) sso_required refuses an unmanaged account on a required domain.
    await owner`insert into authd.required_domains (domain, tenant_id, connection_id)
                values (${acmeDomain}, ${acme}, ${conn.id})`
    await expectRefusal(() => mintFor(ada, acme), "sso_required")

    // 2) sso_exempt lets an exempt unmanaged account pass.
    await owner`insert into authd.required_exempt (connection_id, tenant_id, clerk_user_id, source)
                values (${conn.id}, ${acme}, ${ada}, 'bypass')`
    const exemptDev = await mintFor(ada, acme, "Exempt iPhone")
    expect(await revokeIn(acme, exemptDev.device.id)).toBe(true)
    await owner`delete from authd.required_exempt where tenant_id = ${acme}`
    await owner`delete from authd.required_domains where tenant_id = ${acme}`

    // 3) managed_no_connection refuses a managed account whose connection was deleted (connection_id IS NULL).
    await idStore.claimManaged(acme, {
      clerkUserId: ada,
      tenantId: acme,
      connectionId: conn.id,
      emails: [`ada@${acmeDomain}`],
      reason: "linked",
    })
    await owner`delete from identity.connections where id = ${conn.id}`
    await expectRefusal(() => mintFor(ada, acme), "managed_no_connection")

    // 4) connection_inactive: active = false refuses; active = null passes; active = true passes.
    await idStore.releaseManaged(acme, ada)
    const conn2 = await idStore.createConnection(acme, {
      name: "Acme SSO Active Check",
      protocol: "oidc",
      provider: "okta",
      createdBy: "admin_1",
    })
    await idStore.claimManaged(acme, {
      clerkUserId: ada,
      tenantId: acme,
      connectionId: conn2.id,
      emails: [`ada@${acmeDomain}`],
      reason: "linked",
    })

    // active = false -> refused with connection_inactive
    await owner`insert into authd.passthrough_versions (connection_id, version, fingerprint, active)
                values (${conn2.id}, 1, 'fp1', false)
                on conflict (connection_id) do update set active = false`
    await expectRefusal(() => mintFor(ada, acme), "connection_inactive")

    // active = null -> passes (NULL refuses nothing)
    await owner`update authd.passthrough_versions set active = null where connection_id = ${conn2.id}`
    const nullActiveDev = await mintFor(ada, acme, "Null Active iPhone")
    expect(await revokeIn(acme, nullActiveDev.device.id)).toBe(true)

    // active = true -> passes
    await owner`update authd.passthrough_versions set active = true where connection_id = ${conn2.id}`
    const activeDev = await mintFor(ada, acme, "Active Conn iPhone")
    expect(await revokeIn(acme, activeDev.device.id)).toBe(true)
  })

  it("endFor deletes workspace-wide when clerkUserIds is omitted, batches > 1,000 ids, respects createdBefore, and rejects null tenant without ids", async () => {
    await seedAccounts()
    const d1 = await mintFor(ada, acme, "Old")
    const d2 = await mintFor(bob, acme, "New")
    const dRival = await mintFor(rivalAda, rival)
    await owner`update authd.mail_devices set created_at = now() - interval '10 minutes' where id = ${d1.device.id}`

    // Workspace-wide list returns newest first and respects tenant boundary.
    const acmeDevices = await workspaceDevices(acme)
    expect(acmeDevices.map((d) => d.id)).toEqual([d2.device.id, d1.device.id])

    const removed = await db.transaction((tx) =>
      endFor(tx, {
        tenantId: acme,
        createdBefore: new Date(Date.now() - 5 * 60 * 1000),
      }),
    )
    expect(removed).toBe(1)
    expect(await deviceIds(ada)).toEqual([])
    expect(await deviceIds(bob)).toEqual([d2.device.id])
    expect(await deviceIds(rivalAda)).toEqual([dRival.device.id])

    // Multi-batch (> 1,000 ids) delete spans two batches and deletes both endpoints.
    await mintFor(ada, acme, "Batch First")
    const manyIds = [
      ada,
      ...Array.from({ length: 1003 }, (_, i) => `user_synth_${sfx}_${i}`),
      bob,
    ]
    const batchDeleted = await db.transaction((tx) =>
      endFor(tx, { tenantId: acme, clerkUserIds: manyIds }),
    )
    expect(batchDeleted).toBe(2)
    expect(await deviceIds(ada)).toEqual([])
    expect(await deviceIds(bob)).toEqual([])
    expect(await deviceIds(rivalAda)).toEqual([dRival.device.id])

    // Runtime guard: tenantId null without clerkUserIds throws and deletes nothing.
    const sysDev = await mintFor(systemUser, null, "Sys Protected")
    let threw = false
    try {
      await db.transaction((tx) =>
        endFor(tx, { tenantId: null } as unknown as Parameters<typeof endFor>[1]),
      )
    } catch (err) {
      threw = err instanceof Error && /clerkUserIds/.test(err.message)
    }
    expect(threw).toBe(true)
    expect(await deviceIds(systemUser)).toEqual([sysDev.device.id])
  })
})
