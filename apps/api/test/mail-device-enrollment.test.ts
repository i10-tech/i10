import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { mailDeviceEnrolledSubject, renderMailDeviceEnrolled } from "@repo/emails"
import { parseMailDeviceArgs } from "../scripts/mail-device.js"
import { createApp } from "../src/app.js"
import { loadEnv } from "../src/env.js"
import {
  createEnrollRedisStore,
  EnrollRedisUnavailableError,
  NOTICE_MAX_DELIVERIES,
  startEnrollNoticeConsumer,
  type EnrollRedisLike,
  type NoticeStreamRedis,
  type RedisSessionRecord,
} from "../src/mail-devices/enroll-redis.js"
import {
  newUuidV7,
  parseEdgeLinkKeys,
  signEdgeLinkToken,
  verifyEdgeLinkToken,
} from "../src/mail-devices/link-token.js"
import { mailDeviceEnrolledNotifier } from "../src/mail-devices/notice.js"
import type {
  ActiveOrgReader,
  FreshAuthReader,
  SessionVerifier,
  SsoGateReader,
} from "../src/middleware/session.js"
import type { TenantResolver } from "../src/middleware/tenant.js"
import type {
  ConsoleDeps,
  MailDeviceEnrollmentsDeps,
} from "../src/routes/console/deps.js"
import type { MintGateAccount } from "../src/mail-devices/store.js"

/**
 * Pure unit tests for the API enrollment plane (I10-62):
 *   - Signed edge link token parity against Go's `enrolltoken/testdata/vectors.json`
 *   - `env.ts` enrollment Redis & edge HMAC key validation
 *   - `createEnrollRedisStore` (read-only account gate, the 30 minute link,
 *     fail-closed 503 on Redis errors; the Lua itself runs on a real Redis in
 *     enroll-redis-redis.test.ts)
 *   - `startEnrollNoticeConsumer` (group at 0, XACK only after send, the
 *     advancing XAUTOCLAIM cursor, the delivery cap)
 *   - Post-seal notification email template & idempotency key
 *   - Console routes `/console/mail-devices/enrollments[/:id]`
 *   - Operator CLI `scripts/mail-device.ts` argument parsing
 */

function recordingLog() {
  const lines: { level: string; fields: Record<string, unknown>; msg: string }[] = []
  return {
    lines,
    log: {
      warn: (fields: Record<string, unknown>, msg: string) =>
        lines.push({ level: "warn", fields, msg }),
      error: (fields: Record<string, unknown>, msg: string) =>
        lines.push({ level: "error", fields, msg }),
    },
  }
}

describe("signed edge link tokens (shared vectors with Go enrolltoken)", () => {
  const vectorsPath = resolve(
    import.meta.dir,
    "../../../services/authd/internal/enrolltoken/testdata/vectors.json",
  )
  const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
    keys: string
    valid: { token: string; eid: string; exp: number; kid: number }[]
    invalid: { token: string; why: string }[]
  }

  it("matches every pinned Go valid and invalid test vector byte-for-byte", () => {
    const ring = parseEdgeLinkKeys(vectors.keys)
    expect(ring.signingKey.id).toBe(2)

    for (const v of vectors.valid) {
      const nowBefore = new Date((v.exp - 10) * 1000)
      const claims = verifyEdgeLinkToken(ring, v.token, nowBefore)
      expect(claims).toEqual({
        enrollmentId: v.eid,
        expiresAt: new Date(v.exp * 1000),
        keyId: v.kid,
      })

      // Exact exp boundary is still valid; exp + 1s is expired.
      expect(verifyEdgeLinkToken(ring, v.token, new Date(v.exp * 1000))).not.toBeNull()
      expect(
        verifyEdgeLinkToken(ring, v.token, new Date((v.exp + 1) * 1000)),
      ).toBeNull()

      // Signing with the primary key (kid=2) must reproduce the exact Go token.
      if (v.kid === ring.signingKey.id) {
        const resigned = signEdgeLinkToken(ring, v.eid, new Date(v.exp * 1000))
        expect(resigned).toBe(v.token)
      }
    }

    const activeNow = new Date(1795737000 * 1000)
    for (const inv of vectors.invalid) {
      expect(verifyEdgeLinkToken(ring, inv.token, activeNow)).toBeNull()
    }
  })

  it("generates RFC 9562 UUIDv7 values and refuses malformed ENROLL_EDGE_HMAC_KEY without quoting secrets", () => {
    const id = newUuidV7(new Date("2026-11-27T12:00:00Z"))
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )

    const secretish = "1:NOT_VALID_SECRET_NEVER_ECHO"
    let msg = ""
    try {
      parseEdgeLinkKeys(secretish)
    } catch (err) {
      msg = (err as Error).message
    }
    expect(msg).toContain("ENROLL_EDGE_HMAC_KEY")
    expect(msg).not.toContain("NOT_VALID_SECRET_NEVER_ECHO")

    expect(() => parseEdgeLinkKeys("")).toThrow(/at least one/)
    expect(() => parseEdgeLinkKeys("256:AQID")).toThrow(/0 to 255/)
    expect(() =>
      parseEdgeLinkKeys(
        "1:AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=,1:ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=",
      ),
    ).toThrow(/appears twice/)
  })
})

describe("enrollment env vars (ENROLL_REDIS_* and ENROLL_EDGE_HMAC_KEY)", () => {
  const baseEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgres://i10_api:pw@localhost:5432/i10",
    REDIS_URL: "redis://localhost:6379",
    CLERK_WEBHOOK_SECRET: "whsec_test",
    CLERK_SECRET_KEY: "sk_test_abc",
    MAIL_DOMAINS: "i10.tech",
    SES_CONFIGURATION_SET: "i10-events",
  }
  const validKey = "1:AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA="
  const enrollOn = {
    ...baseEnv,
    ENROLL_REDIS_URL: "redis://i10-enroll-redis.i10-prod.svc:6379",
    ENROLL_REDIS_PASSWORD: "pw",
    ENROLL_EDGE_HMAC_KEY: validKey,
  }

  it("defaults cleanly when unset and requires the password and key with ENROLL_REDIS_URL", () => {
    const off = loadEnv(baseEnv)
    expect(off.ENROLL_REDIS_URL).toBeUndefined()
    expect(off.ENROLL_REDIS_USER).toBe("api")
    expect(off.ENROLL_EDGE_HMAC_KEY).toBeUndefined()
    expect(off.ENROLL_LINK_BASE_URL).toBe("https://ca.i10.tech/enroll/apple")

    const on = loadEnv(enrollOn)
    expect(on.ENROLL_REDIS_URL).toBe("redis://i10-enroll-redis.i10-prod.svc:6379")
    expect(on.ENROLL_EDGE_HMAC_KEY?.signingKey.id).toBe(1)

    expect(() => loadEnv({ ...enrollOn, ENROLL_REDIS_PASSWORD: undefined })).toThrow(
      /ENROLL_REDIS_PASSWORD/,
    )
    expect(() => loadEnv({ ...enrollOn, ENROLL_EDGE_HMAC_KEY: undefined })).toThrow(
      /ENROLL_EDGE_HMAC_KEY/,
    )
  })

  it("takes the link base only as https with no query, fragment or trailing slash", () => {
    for (const bad of [
      "https://ca.i10.tech/enroll/apple/",
      "http://ca.i10.tech/enroll/apple",
      "https://ca.i10.tech/enroll/apple?x=1",
      "https://ca.i10.tech/enroll/apple#x",
    ]) {
      expect(() => loadEnv({ ...enrollOn, ENROLL_LINK_BASE_URL: bad })).toThrow(
        /ENROLL_LINK_BASE_URL/,
      )
    }
    expect(
      loadEnv({ ...enrollOn, ENROLL_LINK_BASE_URL: "https://ca.i10.tech/x" })
        .ENROLL_LINK_BASE_URL,
    ).toBe("https://ca.i10.tech/x")
  })
})

/**
 * Records the commands createEnrollRedisStore sends and answers the scripts
 * with a canned reply. ⚠ IT DOES NOT RE-IMPLEMENT THE LUA: the scripts' own
 * behaviour is tested on a real Redis (enroll-redis-redis.test.ts and the Go
 * tests that run the same files).
 */
class RecordingEnrollRedis implements EnrollRedisLike {
  readonly calls: (string | number)[][] = []
  readonly values = new Map<string, string>()
  failWith: Error | null = null

  async get(key: string): Promise<string | null> {
    if (this.failWith) throw this.failWith
    this.calls.push(["GET", key])
    return this.values.get(key) ?? null
  }

  async call(command: string, ...args: (string | number)[]): Promise<unknown> {
    if (this.failWith) throw this.failWith
    this.calls.push([command, ...args])
    if (command === "SCRIPT") return "sha"
    return "OK"
  }
}

describe("createEnrollRedisStore (console sessions on i10-enroll-redis)", () => {
  const ring = parseEdgeLinkKeys("1:AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=")
  const TENANT = "11111111-1111-4111-8111-111111111111"
  const activeAccount: MintGateAccount = {
    clerk_user_id: "user_ada",
    email: "ada@acme.com",
    active: true,
    tenant_id: TENANT,
    // As postgres.js reads a bigint: text, 16 digits.
    credential_epoch: "1795872953432402",
    suspended: false,
    payment_hold: false,
    deleting: false,
    banned: false,
    locked: false,
    domain_not_hosted: false,
    managed: false,
    managed_connection: null,
    connection_inactive: false,
    sso_required: false,
    sso_exempt: false,
  }

  it("signs the link for creation + 30 minutes while the session must first attest within 15 (M4)", async () => {
    const redis = new RecordingEnrollRedis()
    const created = new Date("2026-11-27T12:00:00.000Z")
    const store = createEnrollRedisStore({
      db: { execute: async () => [activeAccount] } as never,
      redis,
      edgeLinkKeys: ring,
      log: recordingLog().log,
      now: () => created,
    })
    const c = await store.create({ clerkUserId: "user_ada", tenantId: TENANT })
    if (!c.ok) throw new Error("expected ok")
    const token = c.url.slice("https://ca.i10.tech/enroll/apple/".length)
    const at = (min: number, sec = 0) =>
      new Date(created.getTime() + (min * 60 + sec) * 1000)
    expect(verifyEdgeLinkToken(ring, token, at(29, 59))?.enrollmentId).toBe(c.id)
    expect(verifyEdgeLinkToken(ring, token, at(30))?.enrollmentId).toBe(c.id)
    expect(verifyEdgeLinkToken(ring, token, at(30, 1))).toBeNull()

    expect(c.expiresAt).toEqual(at(15))
    const evalsha = redis.calls.find((call) => call[0] === "EVALSHA")!
    const record = JSON.parse(String(evalsha[6])) as RedisSessionRecord
    expect(record.expires_at_ms).toBe(at(15).getTime())
  })

  it("writes the account's credential_epoch as the same decimal string", async () => {
    const redis = new RecordingEnrollRedis()
    const store = createEnrollRedisStore({
      db: { execute: async () => [activeAccount] } as never,
      redis,
      edgeLinkKeys: ring,
      log: recordingLog().log,
    })
    expect((await store.create({ clerkUserId: "user_ada", tenantId: TENANT })).ok).toBe(
      true,
    )
    const evalsha = redis.calls.find((call) => call[0] === "EVALSHA")!
    expect(String(evalsha[6])).toContain('"expected_epoch":"1795872953432402"')
  })

  it("refuses at the gate without touching Redis and fails closed 503 when Redis does", async () => {
    const redis = new RecordingEnrollRedis()
    let row: MintGateAccount = { ...activeAccount, suspended: true }
    const store = createEnrollRedisStore({
      db: { execute: async () => [row] } as never,
      redis,
      edgeLinkKeys: ring,
      log: recordingLog().log,
    })
    expect(await store.create({ clerkUserId: "user_ada", tenantId: TENANT })).toEqual({
      ok: false,
      status: 409,
      code: "mailbox_suspended",
    })
    expect(redis.calls).toEqual([])

    row = activeAccount
    redis.failWith = new Error("OOM command not allowed when used memory > 'maxmemory'")
    expect(await store.create({ clerkUserId: "user_ada", tenantId: TENANT })).toEqual({
      ok: false,
      status: 503,
      code: "enrollment_unavailable",
    })
    const id = "019ab100-0000-7000-8000-000000000001"
    await expect(store.get({ id, clerkUserId: "user_ada" })).rejects.toBeInstanceOf(
      EnrollRedisUnavailableError,
    )
    await expect(store.cancel({ id, clerkUserId: "user_ada" })).rejects.toBeInstanceOf(
      EnrollRedisUnavailableError,
    )
  })
})

describe("enroll:notice stream consumer", () => {
  const notice = (id: string, email: string): [string, string[]] => [
    id,
    [
      "deviceId",
      `dev-${id}`,
      "email",
      email,
      "platform",
      "ios",
      "model",
      "iPhone17,2",
      "serialLast4",
      "1234",
    ],
  ]

  function streamRedis(opts: {
    fresh?: [string, string[]][]
    claimed?: [string, string[]][]
    nextCursor?: string
    deliveries?: Record<string, number>
  }) {
    const calls: (string | number)[][] = []
    const acked: string[] = []
    let reads = 0
    const redis: NoticeStreamRedis = {
      call: async (command, ...args) => {
        calls.push([command, ...args])
        switch (command) {
          case "XGROUP":
            return "OK"
          case "XREADGROUP":
            return reads++ === 0 && opts.fresh ? [["enroll:notice", opts.fresh]] : null
          case "XAUTOCLAIM":
            return [opts.nextCursor ?? "0-0", opts.claimed ?? [], []]
          case "XPENDING":
            return (opts.claimed ?? [])
              .filter(([id]) => id === args[2])
              .map(([id]) => [id, "c", 60_000, opts.deliveries?.[id] ?? 2])
          case "XACK":
            acked.push(String(args[2]))
            return 1
        }
        throw new Error(`unexpected stream command ${command}`)
      },
    }
    return { redis, calls, acked }
  }

  it("creates the group at 0 so a notice written before the group exists is still sent", async () => {
    const { redis, calls, acked } = streamRedis({
      fresh: [notice("1-0", "ada@acme.com")],
    })
    const sent: string[] = []
    const consumer = startEnrollNoticeConsumer({
      redis,
      notify: async (p) => void sent.push(p.deviceId),
      log: recordingLog().log,
      consumerName: "c",
      autoStart: false,
    })
    expect(await consumer.pollOnce({ reclaim: false })).toBe(1)
    expect(calls[0]).toEqual([
      "XGROUP",
      "CREATE",
      "enroll:notice",
      "i10-api",
      "0",
      "MKSTREAM",
    ])
    expect(sent).toEqual(["dev-1-0"])
    expect(acked).toEqual(["1-0"])
  })

  it("acks only after a send, leaves a failed send pending, and drops malformed entries", async () => {
    const { redis, acked } = streamRedis({
      fresh: [notice("1-0", "ada@acme.com"), ["2-0", ["deviceId", "no-email"]]],
    })
    const consumer = startEnrollNoticeConsumer({
      redis,
      notify: async () => {
        throw new Error("SES down")
      },
      log: recordingLog().log,
      consumerName: "c",
      autoStart: false,
    })
    expect(await consumer.pollOnce({ reclaim: false })).toBe(0)
    expect(acked).toEqual(["2-0"])
  })

  it("advances the XAUTOCLAIM cursor instead of restarting at 0-0", async () => {
    const { redis, calls } = streamRedis({
      claimed: [notice("5-0", "bob@acme.com")],
      nextCursor: "9-0",
    })
    const consumer = startEnrollNoticeConsumer({
      redis,
      notify: async () => {},
      log: recordingLog().log,
      consumerName: "c",
      autoStart: false,
    })
    await consumer.pollOnce({ reclaim: true })
    await consumer.pollOnce({ reclaim: true })
    const cursors = calls.filter((c) => c[0] === "XAUTOCLAIM").map((c) => c[5])
    expect(cursors).toEqual(["0-0", "9-0"])
  })

  it("logs and acks an entry past the delivery cap without sending it", async () => {
    const { redis, acked } = streamRedis({
      claimed: [notice("5-0", "bob@acme.com"), notice("6-0", "eve@acme.com")],
      deliveries: { "5-0": NOTICE_MAX_DELIVERIES + 1, "6-0": 3 },
    })
    const sent: string[] = []
    const { lines, log } = recordingLog()
    const consumer = startEnrollNoticeConsumer({
      redis,
      notify: async (p) => void sent.push(p.deviceId),
      log,
      consumerName: "c",
      autoStart: false,
    })
    await consumer.pollOnce({ reclaim: true })
    expect(sent).toEqual(["dev-6-0"])
    expect(acked).toEqual(["5-0", "6-0"])
    const dropped = lines.find((l) => l.level === "error")
    expect(dropped?.fields).toMatchObject({ entryId: "5-0", deviceId: "dev-5-0" })
    expect(JSON.stringify(lines)).not.toContain("bob@acme.com")
  })
})

describe("post-seal notification email (Review 1 H2)", () => {
  it("uses /account#mail-devices, stable idempotency key, and model + serialLast4", async () => {
    const templateSrc = readFileSync(
      resolve(
        import.meta.dir,
        "../../../packages/emails/src/templates/mail-device-enrolled.tsx",
      ),
      "utf8",
    )
    expect(templateSrc).toContain('url: "https://dash.i10.tech/account#mail-devices"')
    expect(templateSrc).not.toContain("dash.i10.tech/mail-devices")

    const sent: {
      to: string
      subject: string
      html: string
      text?: string
      idempotencyKey: string
    }[] = []
    const notify = mailDeviceEnrolledNotifier({
      sender: {
        send: async (msg) => {
          sent.push(msg)
        },
      },
      consoleUrl: "https://dash.i10.tech/",
    })

    await notify({
      email: "ada@acme.com",
      deviceId: "019ab100-0000-7000-8000-000000000099",
      platform: "macos",
      model: "Mac14,2",
      serialLast4: "9X4K",
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      to: "ada@acme.com",
      subject: mailDeviceEnrolledSubject("Mac14,2"),
      idempotencyKey: "mail-device-enrolled:019ab100-0000-7000-8000-000000000099",
    })
    expect(sent[0]!.html).toContain("https://dash.i10.tech/account#mail-devices")
    expect(sent[0]!.html).toContain("Mac14,2")
    expect(sent[0]!.html).toContain("9X4K")
    expect(sent[0]!.text).toContain("https://dash.i10.tech/account#mail-devices")

    const rendered = await renderMailDeviceEnrolled({
      email: "ada@acme.com",
      model: "iPhone16,2",
      serialLast4: "9X4K",
      url: "https://dash.i10.tech/account#mail-devices",
    })
    expect(rendered.html).toContain("https://dash.i10.tech/account#mail-devices")
  })
})

describe("console routes /console/mail-devices/enrollments[/:id]", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111"
  const ENROLLMENT_ID = "019ab100-0000-7000-8000-000000000010"
  const DEVICE_ID = "019ab100-0000-7000-8000-000000000020"
  const BEARER = { Authorization: "Bearer stub" }
  const EXPIRES = new Date("2026-11-27T02:15:00.000Z")

  const sessions: SessionVerifier = {
    verify: async () => ({ status: "signed-in", userId: "user_ada" }),
  }
  const tenants: TenantResolver = { resolve: async () => TENANT }
  const fresh: FreshAuthReader = async () => ({ status: "fresh" })
  const stale: FreshAuthReader = async () => ({ status: "stale" })

  function makeApp(options: {
    freshAuth?: FreshAuthReader
    activeOrg?: ActiveOrgReader
    tenants?: TenantResolver
    mailDeviceEnrollments?: MailDeviceEnrollmentsDeps
    ssoGate?: SsoGateReader
  }) {
    return createApp({
      ...(options.ssoGate ? { ssoGate: options.ssoGate } : {}),
      console: {
        sessions,
        tenants: options.tenants ?? tenants,
        ...(options.activeOrg ? { activeOrg: options.activeOrg } : {}),
        ...(options.freshAuth ? { freshAuth: options.freshAuth } : {}),
        ...(options.mailDeviceEnrollments
          ? { mailDeviceEnrollments: options.mailDeviceEnrollments }
          : {}),
        queries: {} as ConsoleDeps["queries"],
        usage: {} as ConsoleDeps["usage"],
        onboarding: {} as ConsoleDeps["onboarding"],
        profile: {} as ConsoleDeps["profile"],
        marketing: {} as ConsoleDeps["marketing"],
        log: { error: () => {}, warn: () => {} },
      },
    })
  }

  const stubDeps = (
    overrides: Partial<MailDeviceEnrollmentsDeps> = {},
  ): MailDeviceEnrollmentsDeps => ({
    mailboxTenant: async () => ({ tenantId: TENANT }),
    create: async () => ({
      ok: true,
      id: ENROLLMENT_ID,
      url: "https://ca.i10.tech/enroll/apple/v1.tok",
      expiresAt: EXPIRES,
    }),
    get: async ({ id, clerkUserId }) =>
      id === ENROLLMENT_ID && clerkUserId === "user_ada"
        ? {
            id: ENROLLMENT_ID,
            status: "sealed",
            expiresAt: EXPIRES,
            refusal: null,
            platform: "macos",
            model: "Mac14,2",
            deviceName: "Ada's MacBook Air",
            deviceId: DEVICE_ID,
            needsMailSetup: true,
          }
        : null,
    cancel: async ({ id, clerkUserId }) =>
      id === ENROLLMENT_ID && clerkUserId === "user_ada" ? "cancelled" : "not_found",
    ...overrides,
  })

  it("POST requires fresh auth (403 stale, 501 unwired) and returns 201 with Cache-Control: no-store", async () => {
    const staleRes = await makeApp({
      freshAuth: stale,
      mailDeviceEnrollments: stubDeps(),
    }).request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: "{}",
    })
    expect(staleRes.status).toBe(403)
    expect(await staleRes.json()).toMatchObject({
      clerk_error: { reason: "reverification-error" },
    })

    const noFreshRes = await makeApp({
      mailDeviceEnrollments: stubDeps(),
    }).request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: BEARER,
      body: "{}",
    })
    expect(noFreshRes.status).toBe(501)

    const okRes = await makeApp({
      freshAuth: fresh,
      mailDeviceEnrollments: stubDeps(),
    }).request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: "{}",
    })
    expect(okRes.status).toBe(201)
    expect(okRes.headers.get("cache-control")).toBe("no-store")
    expect(await okRes.json()).toEqual({
      id: ENROLLMENT_ID,
      url: "https://ca.i10.tech/enroll/apple/v1.tok",
      expiresAt: EXPIRES.toISOString(),
    })

    for (const badBody of ["[1,2]", '"str"', "{bad"]) {
      const badRes = await makeApp({
        freshAuth: fresh,
        mailDeviceEnrollments: stubDeps(),
      }).request("/console/mail-devices/enrollments", {
        method: "POST",
        headers: { ...BEARER, "content-type": "application/json" },
        body: badBody,
      })
      expect(badRes.status).toBe(422)
    }
  })

  it("works without an active workspace (Review 1: i10.tech mailboxes have no workspace)", async () => {
    const noOrg: ActiveOrgReader = async () => ({ status: "personal" })
    const noTenant: TenantResolver = { resolve: async () => null }
    const app = makeApp({
      freshAuth: fresh,
      activeOrg: noOrg,
      tenants: noTenant,
      mailDeviceEnrollments: stubDeps(),
    })

    const postRes = await app.request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: BEARER,
      body: "{}",
    })
    expect(postRes.status).toBe(201)

    const getRes = await app.request(
      `/console/mail-devices/enrollments/${ENROLLMENT_ID}`,
      {
        headers: BEARER,
      },
    )
    expect(getRes.status).toBe(200)
    expect(getRes.headers.get("cache-control")).toBe("no-store")
    expect(await getRes.json()).toEqual({
      id: ENROLLMENT_ID,
      status: "sealed",
      expiresAt: EXPIRES.toISOString(),
      refusal: null,
      platform: "macos",
      model: "Mac14,2",
      deviceName: "Ada's MacBook Air",
      deviceId: DEVICE_ID,
      needsMailSetup: true,
    })

    const delRes = await app.request(
      `/console/mail-devices/enrollments/${ENROLLMENT_ID}`,
      {
        method: "DELETE",
        headers: BEARER,
      },
    )
    expect(delRes.status).toBe(204)
  })

  it("runs the mailbox workspace's console policies when another workspace or none is open", async () => {
    const MAILBOX_TENANT = "22222222-2222-4222-8222-222222222222"
    const gated: (string | undefined)[] = []
    const ssoGate: SsoGateReader = async (_req, _userId, tenantId) => {
      gated.push(tenantId)
      return tenantId === MAILBOX_TENANT
        ? { status: "mfa_required" }
        : { status: "pass" }
    }
    const created: { tenantId: string | null }[] = []
    const deps = stubDeps({
      mailboxTenant: async () => ({ tenantId: MAILBOX_TENANT }),
      create: async (input) => {
        created.push({ tenantId: input.tenantId })
        return {
          ok: true,
          id: ENROLLMENT_ID,
          url: "https://ca.i10.tech/enroll/apple/t",
          expiresAt: EXPIRES,
        }
      },
    })
    const post = (app: ReturnType<typeof makeApp>) =>
      app.request("/console/mail-devices/enrollments", {
        method: "POST",
        headers: BEARER,
      })

    for (const activeOrg of [
      async () => ({ status: "personal" }) as const,
      async () => ({ status: "org", orgId: "org_other" }) as const,
    ] satisfies ActiveOrgReader[]) {
      const res = await post(
        makeApp({ freshAuth: fresh, activeOrg, ssoGate, mailDeviceEnrollments: deps }),
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ name: "mfa_required" })
    }
    expect(created).toEqual([])
    expect(gated).toContain(MAILBOX_TENANT)

    // Reading or cancelling the enrollment meets the same policies.
    let cancelled = 0
    const refusedApp = makeApp({
      freshAuth: fresh,
      activeOrg: async () => ({ status: "personal" }),
      ssoGate,
      mailDeviceEnrollments: {
        ...deps,
        cancel: async () => {
          cancelled++
          return "cancelled"
        },
      },
    })
    const path = `/console/mail-devices/enrollments/${ENROLLMENT_ID}`
    for (const method of ["GET", "DELETE"]) {
      const res = await refusedApp.request(path, { method, headers: BEARER })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ name: "mfa_required" })
    }
    expect(cancelled).toBe(0)

    // Its own workspace open: requireTenant already ran that gate, and the
    // tenant the route read is the one create checks under the account lock.
    const own = await post(
      makeApp({
        freshAuth: fresh,
        tenants: { resolve: async () => MAILBOX_TENANT },
        ssoGate: async () => ({ status: "pass" }),
        mailDeviceEnrollments: deps,
      }),
    )
    expect(own.status).toBe(201)
    expect(created).toEqual([{ tenantId: MAILBOX_TENANT }])

    // An i10.tech mailbox has no workspace whose policies could apply.
    const none = await post(
      makeApp({
        freshAuth: fresh,
        ssoGate,
        mailDeviceEnrollments: stubDeps({
          mailboxTenant: async () => ({ tenantId: null }),
        }),
      }),
    )
    expect(none.status).toBe(201)

    const noMailbox = await post(
      makeApp({
        freshAuth: fresh,
        mailDeviceEnrollments: stubDeps({ mailboxTenant: async () => null }),
      }),
    )
    expect(noMailbox.status).toBe(409)
    expect(await noMailbox.json()).toMatchObject({ name: "no_mailbox" })
  })

  it("maps 409 refusals, 503 Redis unavailable, 404, 409 already_sealed, and 501 unwired", async () => {
    const downApp = makeApp({
      freshAuth: fresh,
      mailDeviceEnrollments: stubDeps({
        create: async () => ({
          ok: false,
          status: 503,
          code: "enrollment_unavailable",
        }),
        get: async () => {
          throw new EnrollRedisUnavailableError()
        },
        cancel: async () => {
          throw new EnrollRedisUnavailableError()
        },
      }),
    })
    for (const [method, path] of [
      ["POST", "/console/mail-devices/enrollments"],
      ["GET", `/console/mail-devices/enrollments/${ENROLLMENT_ID}`],
      ["DELETE", `/console/mail-devices/enrollments/${ENROLLMENT_ID}`],
    ] as const) {
      const res = await downApp.request(path, { method, headers: BEARER })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({
        statusCode: 503,
        name: "enrollment_unavailable",
        message: "Device setup is not available right now.",
      })
    }

    const conflictApp = makeApp({
      freshAuth: fresh,
      mailDeviceEnrollments: stubDeps({
        create: async () => ({ ok: false, status: 409, code: "no_mailbox" }),
        cancel: async () => "already_sealed",
      }),
    })
    const cRes = await conflictApp.request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: BEARER,
      body: "{}",
    })
    expect(cRes.status).toBe(409)
    expect(await cRes.json()).toMatchObject({ statusCode: 409, name: "no_mailbox" })

    // A gate refusal from create (mintRefusal) keeps its word as the name.
    const heldApp = makeApp({
      freshAuth: fresh,
      mailDeviceEnrollments: stubDeps({
        create: async () => ({ ok: false, status: 409, code: "payment_hold" }),
      }),
    })
    const hRes = await heldApp.request("/console/mail-devices/enrollments", {
      method: "POST",
      headers: BEARER,
      body: "{}",
    })
    expect(hRes.status).toBe(409)
    expect(await hRes.json()).toMatchObject({ statusCode: 409, name: "payment_hold" })

    const sealedDel = await conflictApp.request(
      `/console/mail-devices/enrollments/${ENROLLMENT_ID}`,
      { method: "DELETE", headers: BEARER },
    )
    expect(sealedDel.status).toBe(409)
    expect(await sealedDel.json()).toMatchObject({
      statusCode: 409,
      name: "already_sealed",
    })

    const badUuid = await conflictApp.request(
      "/console/mail-devices/enrollments/not-a-uuid",
      { headers: BEARER },
    )
    expect(badUuid.status).toBe(404)

    const otherId = await conflictApp.request(
      `/console/mail-devices/enrollments/${DEVICE_ID}`,
      { headers: BEARER },
    )
    expect(otherId.status).toBe(404)

    const unwired = makeApp({ freshAuth: fresh })
    for (const [method, path] of [
      ["POST", "/console/mail-devices/enrollments"],
      ["GET", `/console/mail-devices/enrollments/${ENROLLMENT_ID}`],
      ["DELETE", `/console/mail-devices/enrollments/${ENROLLMENT_ID}`],
    ] as const) {
      expect((await unwired.request(path, { method, headers: BEARER })).status).toBe(
        501,
      )
    }
  })
})

describe("operator CLI scripts/mail-device.ts certificate commands", () => {
  const id = "019abcde-0123-789a-8bcd-ef0123456789"

  it("parses bind-key and unbind-key positionally and refuses removed acme-permit", () => {
    expect(
      parseMailDeviceArgs(["bind-key", id.toUpperCase(), "/tmp/leaf.pem"]),
    ).toEqual({
      action: "bind-key",
      id,
      certificatePath: "/tmp/leaf.pem",
      replace: false,
    })
    expect(parseMailDeviceArgs(["bind-key", id, "/tmp/leaf.pem", "--replace"])).toEqual(
      {
        action: "bind-key",
        id,
        certificatePath: "/tmp/leaf.pem",
        replace: true,
      },
    )
    expect(parseMailDeviceArgs(["unbind-key", id])).toEqual({
      action: "unbind-key",
      id,
    })
    expect(() => parseMailDeviceArgs(["acme-permit", id])).toThrow(/Unknown command/)
  })
})
