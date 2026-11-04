import { memoryMail } from "./identity-mail-fakes.js"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { describe, expect, it, afterAll, beforeAll, spyOn } from "bun:test"
import { Hono } from "hono"
import { createApp } from "../src/app.js"
import { addMember, type Role } from "../src/console/roles.js"
import { loadEnv } from "../src/env.js"
import { applyDirectoryUser, type DirectoryDeps } from "../src/identity/directory.js"
import { GOOGLE_WATCH_EVENTS } from "../src/identity/directory-ports.js"
import {
  GOOGLE_DIRECTORY_API_BASE,
  GOOGLE_DIRECTORY_ERRORS,
  GOOGLE_DIRECTORY_SCOPES,
  GOOGLE_GROUP_MEMBERS_CONCURRENCY,
  GOOGLE_MAX_DROP_PERCENT,
  GOOGLE_MAX_DROP_USERS,
  GOOGLE_TOKEN_URL,
  GOOGLE_WATCH_RENEW_BEFORE_MS,
  GOOGLE_WATCH_TTL_MS,
  GoogleFailure,
  TOKEN_REFRESH_SKEW_MS,
  buildGoogleJwtAssertion,
  canonicalJson,
  checkGoogleDirectoryAccess,
  createGoogleTokenSource,
  ensureGoogleWatchChannels,
  mapConcurrent,
  mapGoogleUser,
  parseGoogleServiceAccount,
  parseRetryAfterMs,
  pullGoogleDirectory,
  stopGoogleWatchChannels,
  withGoogleRetry,
  type GoogleDirectoryErrorCode,
} from "../src/identity/google-directory.js"
import type { DeprovisionDeps } from "../src/identity/managed.js"
import type { AuditEvent } from "../src/identity/ports.js"
import { hashSecret } from "../src/identity/model.js"
import { guardedFetch } from "../src/identity/oidc-fetch.js"
import { fixedWindow } from "../src/identity/rate-limit.js"
import {
  GOOGLE_PULL_INTERVAL_MS,
  enqueueDueGoogleDirectories,
  googlePullJobId,
  googlePullScheduler,
  runGoogleDirectoryJob,
  startGoogleDirectoryScheduler,
  type GooglePullJob,
} from "../src/queue/google-directory-queue.js"
import { mountIdentity } from "../src/routes/console/identity.js"
import {
  GOOGLE_UNAVAILABLE_REASON,
  type GoogleConsoleDeps,
} from "../src/routes/console/identity-scim.js"
import type { ConsoleDeps } from "../src/routes/console/deps.js"
import { createScimRoutes } from "../src/routes/scim.js"
import { vetHost } from "../src/webhooks/egress.js"
import {
  CONNECTION,
  ORG,
  OTHER_TENANT,
  TENANT,
  connection,
  log,
  memoryClerk,
  memoryStore,
  user,
} from "./identity-fakes.js"
import {
  DIRECTORY,
  OTHER_DIRECTORY,
  memoryDirectories,
  memoryProvisioning,
  scimToken,
} from "./identity-scim-fakes.js"
import { ACME, row as roleRow, rolesDeps } from "./role-fixtures.js"
import { EDGE_PROOF, EDGE_SECRET } from "./edge-fixture.js"

// The retry backoff waits for real; a suite of refused calls must not.
const retryWaits = spyOn(globalThis, "setTimeout")
beforeAll(() => {
  retryWaits.mockImplementation(((run: () => void) => {
    queueMicrotask(run)
    return 0
  }) as unknown as typeof setTimeout)
})
afterAll(() => retryWaits.mockRestore())

/**
 * Google Workspace directory sync (#343): domain-wide delegation credentials,
 * RS256 token minting and caching, console settings and check-access, bounded
 * full-pull mapping and reconciliation, incomplete-pull safety, 15-minute
 * scheduling, and `users.watch` push notifications.
 *
 * Refusals come before happy paths in every section. All HTTP runs through
 * `guardedFetch` backed by in-memory fakes; nothing calls Google or DNS.
 */

const { privateKey: RSA_PRIVATE_KEY, publicKey: RSA_PUBLIC_KEY } = generateKeyPairSync(
  "rsa",
  { modulusLength: 2048 },
)
const RSA_PEM = RSA_PRIVATE_KEY.export({ type: "pkcs8", format: "pem" }).toString()

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: "service_account",
  project_id: "i10-identity",
  private_key_id: "kid_google_343",
  private_key: RSA_PEM,
  client_email: "directory-sync@i10-identity.iam.gserviceaccount.com",
  client_id: "109876543210987654321",
})

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://i10_api:pw@localhost:5432/i10",
  REDIS_URL: "redis://localhost:6379",
  CLERK_WEBHOOK_SECRET: "whsec_test",
  CLERK_SECRET_KEY: "sk_test_abc",
  MAIL_DOMAINS: "i10.tech",
  SES_CONFIGURATION_SET: "i10-events",
}

interface RecordedCall {
  method: string
  url: URL
  headers: Headers
  body: string
}

function fakeGoogleFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
  options: { address?: string; maxBytes?: number; timeoutMs?: number } = {},
) {
  const calls: RecordedCall[] = []
  const address = options.address ?? "142.250.74.106"
  const gf = guardedFetch({
    vet: (host, signal) =>
      vetHost(host, {
        lookup: async () => [{ address, family: 4 }],
        signal,
      }),
    timeoutMs: options.timeoutMs ?? 5_000,
    maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const logical = new URL(String(input))
      const headers = new Headers(init?.headers)
      const host = headers.get("host")
      if (host) logical.host = host
      const body = typeof init?.body === "string" ? init.body : ""
      const call: RecordedCall = {
        method: init?.method ?? "GET",
        url: logical,
        headers,
        body,
      }
      calls.push(call)
      return handler(call)
    }) as typeof fetch,
  })
  return { fetch: gf, calls }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each test inspects its own response shape
const readBody = async (res: Response) => (await res.json()) as Record<string, any>

function reverseKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(reverseKeys)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([k, v]) => [k, reverseKeys(v)]),
  )
}

// ── 1. Service account credentials & env ────────────────────────────────────

describe("GOOGLE_DIRECTORY_SERVICE_ACCOUNT & parseGoogleServiceAccount", () => {
  it("refuses malformed JSON, missing fields, and non-RSA keys without leaking the key", () => {
    const secretMarker = "SUPER_SECRET_PEM_MATERIAL_NEVER_LOG"
    const badInputs = [
      `not-json-${secretMarker}`,
      "null",
      "[]",
      JSON.stringify({ client_email: "sa@test.iam.gserviceaccount.com" }),
      JSON.stringify({ private_key: RSA_PEM }),
      JSON.stringify({
        client_email: "sa@test.iam.gserviceaccount.com",
        private_key: `-----BEGIN PRIVATE KEY-----\n${secretMarker}\n-----END PRIVATE KEY-----`,
      }),
    ]
    for (const raw of badInputs) {
      let caught: Error | null = null
      try {
        parseGoogleServiceAccount(raw)
      } catch (error) {
        caught = error as Error
      }
      expect(caught).not.toBeNull()
      expect(caught!.message).not.toContain(secretMarker)
      expect(caught!.message).not.toContain("BEGIN PRIVATE KEY")
    }

    const { privateKey: edKey } = generateKeyPairSync("ed25519")
    const edPem = edKey.export({ type: "pkcs8", format: "pem" }).toString()
    expect(() =>
      parseGoogleServiceAccount(
        JSON.stringify({
          client_email: "sa@test.iam.gserviceaccount.com",
          private_key: edPem,
        }),
      ),
    ).toThrow(/RSA/)

    expect(() =>
      loadEnv({ ...BASE_ENV, GOOGLE_DIRECTORY_SERVICE_ACCOUNT: "{bad" }),
    ).toThrow()
  })

  it("allows GOOGLE_DIRECTORY_SERVICE_ACCOUNT to be unset or empty, and parses a valid RSA key", () => {
    expect(loadEnv(BASE_ENV).GOOGLE_DIRECTORY_SERVICE_ACCOUNT).toBeUndefined()
    expect(
      loadEnv({ ...BASE_ENV, GOOGLE_DIRECTORY_SERVICE_ACCOUNT: "   " })
        .GOOGLE_DIRECTORY_SERVICE_ACCOUNT,
    ).toBeUndefined()

    const loaded = loadEnv({
      ...BASE_ENV,
      GOOGLE_DIRECTORY_SERVICE_ACCOUNT: SERVICE_ACCOUNT_JSON,
    })
    expect(loaded.GOOGLE_DIRECTORY_SERVICE_ACCOUNT).toBe(SERVICE_ACCOUNT_JSON)

    const sa = parseGoogleServiceAccount(SERVICE_ACCOUNT_JSON)
    expect(sa.clientEmail).toBe("directory-sync@i10-identity.iam.gserviceaccount.com")
    expect(sa.clientId).toBe("109876543210987654321")
    expect(sa.privateKeyId).toBe("kid_google_343")
    expect(JSON.stringify(sa)).not.toContain("BEGIN PRIVATE KEY")
  })
})

// ── 2. JWT bearer grant, token cache & egress guard ─────────────────────────

describe("token minting: refusals first, then RS256 claims, cache and expiry", () => {
  const sa = parseGoogleServiceAccount(SERVICE_ACCOUNT_JSON)

  it("refuses private egress addresses, non-https URLs, invalid admin emails, and OAuth errors with fixed codes", async () => {
    const blocked = fakeGoogleFetch(
      () => jsonResponse({ access_token: "t", expires_in: 3600 }),
      {
        address: "127.0.0.1",
      },
    )
    const blockedTokens = createGoogleTokenSource({
      serviceAccount: sa,
      fetch: blocked.fetch,
    })
    await expect(blockedTokens.tokenFor("admin@acme.test")).rejects.toMatchObject({
      name: "GoogleFailure",
      code: "unreachable",
      retryable: true,
    })
    expect(blocked.calls).toHaveLength(0)

    await expect(
      blocked.fetch("http://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {},
      }),
    ).rejects.toMatchObject({ name: "IdpUnreachable" })

    const unused = fakeGoogleFetch(() =>
      jsonResponse({ access_token: "t", expires_in: 3600 }),
    )
    const source = createGoogleTokenSource({ serviceAccount: sa, fetch: unused.fetch })
    await expect(source.tokenFor("not-an-email")).rejects.toMatchObject({
      code: "not_configured",
      retryable: false,
    })
    expect(unused.calls).toHaveLength(0)

    const cases: {
      status: number
      body: unknown
      expected: GoogleFailure["code"]
      retryable: boolean
    }[] = [
      {
        status: 401,
        body: {
          error: "unauthorized_client",
          error_description:
            "Client is unauthorized to retrieve access tokens: RAW_SECRET_DETAIL",
        },
        expected: "delegation_missing",
        retryable: false,
      },
      {
        status: 401,
        body: {
          error: "invalid_client",
          error_description: "OAuth client was not found: RAW_CLIENT_DETAIL",
        },
        expected: "unauthorized_client",
        retryable: false,
      },
      {
        status: 400,
        body: {
          error: "invalid_scope",
          error_description: "Empty or missing scope not allowed: RAW_GOOGLE_MSG",
        },
        expected: "missing_scope",
        retryable: false,
      },
      {
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: "Invalid email or User ID: RAW_GOOGLE_MSG",
        },
        expected: "admin_not_found",
        retryable: false,
      },
      {
        status: 429,
        body: { error: "rate_limit" },
        expected: "rate_limited",
        retryable: true,
      },
      {
        status: 503,
        body: "upstream unavailable",
        expected: "unreachable",
        retryable: true,
      },
      {
        status: 200,
        body: { access_token: "", expires_in: "bad" },
        expected: "invalid_response",
        retryable: false,
      },
    ]

    for (const c of cases) {
      const f = fakeGoogleFetch(() =>
        typeof c.body === "string"
          ? new Response(c.body, { status: c.status })
          : jsonResponse(c.body, c.status),
      )
      const ts = createGoogleTokenSource({ serviceAccount: sa, fetch: f.fetch })
      let err: GoogleFailure | null = null
      try {
        await ts.tokenFor("admin@acme.test")
      } catch (e) {
        err = e as GoogleFailure
      }
      expect(err).toBeInstanceOf(GoogleFailure)
      expect(err!.code).toBe(c.expected)
      expect(err!.retryable).toBe(c.retryable)
      expect(err!.message).toBe(c.expected)
      expect(err!.message).not.toContain("RAW_")
    }
  })

  it("signs an RS256 JWT assertion with the exact claims and caches until shortly before expiry", async () => {
    let clockMs = Date.parse("2026-10-24T12:00:00Z")
    let minted = 0
    const net = fakeGoogleFetch((call) => {
      expect(call.url.href).toBe(GOOGLE_TOKEN_URL)
      expect(call.method).toBe("POST")
      expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
      const params = new URLSearchParams(call.body)
      expect(params.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      )
      const jwt = params.get("assertion")!
      const parts = jwt.split(".")
      expect(parts).toHaveLength(3)
      const [h64, p64, sig64] = parts as [string, string, string]

      const verifier = createVerify("RSA-SHA256")
      verifier.update(`${h64}.${p64}`)
      verifier.end()
      expect(verifier.verify(RSA_PUBLIC_KEY, Buffer.from(sig64, "base64url"))).toBe(
        true,
      )

      const header = JSON.parse(Buffer.from(h64, "base64url").toString("utf8"))
      const payload = JSON.parse(Buffer.from(p64, "base64url").toString("utf8"))
      expect(header).toEqual({
        alg: "RS256",
        typ: "JWT",
        kid: "kid_google_343",
      })
      const expectedIat = Math.floor(clockMs / 1000)
      expect(payload).toEqual({
        iss: "directory-sync@i10-identity.iam.gserviceaccount.com",
        sub: "admin@acme.test",
        scope:
          "https://www.googleapis.com/auth/admin.directory.user.readonly https://www.googleapis.com/auth/admin.directory.group.readonly",
        aud: "https://oauth2.googleapis.com/token",
        iat: expectedIat,
        exp: expectedIat + 3600,
      })

      minted += 1
      return jsonResponse({
        access_token: `goog_tok_${minted}`,
        expires_in: 3600,
        token_type: "Bearer",
      })
    })

    const tokens = createGoogleTokenSource({
      serviceAccount: sa,
      fetch: net.fetch,
      now: () => new Date(clockMs),
    })

    // Concurrent calls for the same admin share one token exchange.
    const [first, concurrent] = await Promise.all([
      tokens.tokenFor(" Admin@Acme.Test "),
      tokens.tokenFor("admin@acme.test"),
    ])
    expect(first).toBe("goog_tok_1")
    expect(concurrent).toBe("goog_tok_1")
    expect(minted).toBe(1)

    // Still cached 1 second before the 5-minute refresh window.
    clockMs += 3600_000 - TOKEN_REFRESH_SKEW_MS - 1_000
    expect(await tokens.tokenFor("admin@acme.test")).toBe("goog_tok_1")
    expect(minted).toBe(1)

    // Entering the skew window refreshes before Google rejects it.
    clockMs += 2_000
    expect(await tokens.tokenFor("admin@acme.test")).toBe("goog_tok_2")
    expect(minted).toBe(2)

    // A 401 from the Directory API evicts the cached token and mints a fresh one once.
    let apiAttempt = 0
    const retryNet = fakeGoogleFetch((call) => {
      if (call.url.href === GOOGLE_TOKEN_URL) {
        minted += 1
        return jsonResponse({ access_token: `goog_tok_${minted}`, expires_in: 3600 })
      }
      apiAttempt += 1
      if (apiAttempt === 1) return jsonResponse({ error: { code: 401 } }, 401)
      expect(call.headers.get("authorization")).toBe("Bearer goog_tok_4")
      return jsonResponse({ users: [] })
    })
    const retryTokens = createGoogleTokenSource({
      serviceAccount: sa,
      fetch: retryNet.fetch,
      now: () => new Date(clockMs),
    })
    const retryDirs = memoryDirectories({ domains: ["acme.test"] })
    expect(
      await checkGoogleDirectoryAccess(
        { tokens: retryTokens, fetch: retryNet.fetch, store: retryDirs.store },
        { tenantId: TENANT, adminEmail: "admin@acme.test", domain: "acme.test" },
      ),
    ).toEqual({ ok: true })
    expect(apiAttempt).toBe(2)

    // Direct assertion builder matches too.
    const rawJwt = buildGoogleJwtAssertion(
      sa,
      "it@acme.test",
      new Date("2026-10-24T00:00:00Z"),
    )
    expect(rawJwt.split(".")).toHaveLength(3)
  })
})

// ── 3. Console directory settings, unset env & check-access ─────────────────

describe("console Google directory routes: refusals first, then owner flow", () => {
  const ROLES: Record<string, Role> = {
    user_owner: "owner",
    user_admin: "admin",
    user_member: "member",
  }
  const sa = parseGoogleServiceAccount(SERVICE_ACCOUNT_JSON)

  function buildConsole(
    opts: {
      serviceAccountConfigured?: boolean
      fresh?: boolean
      domains?: string[]
      googleHandler?: (call: RecordedCall) => Response | Promise<Response>
    } = {},
  ) {
    const identity = memoryStore()
    const liveDomains = [...(opts.domains ?? ["acme.test"])]
    const dirs = memoryDirectories({
      directories: [{ id: DIRECTORY, name: "Okta", provider: "okta" }],
      domains: liveDomains,
    })
    let fresh = opts.fresh ?? true
    const net = fakeGoogleFetch(
      opts.googleHandler ??
        ((call) => {
          if (call.url.href === GOOGLE_TOKEN_URL)
            return jsonResponse({ access_token: "tok_check", expires_in: 3600 })
          return jsonResponse({ users: [{ id: "g1", primaryEmail: "ada@acme.test" }] })
        }),
    )
    const configured = opts.serviceAccountConfigured ?? true
    const tokens = configured
      ? createGoogleTokenSource({ serviceAccount: sa, fetch: net.fetch })
      : null
    const pullsScheduled: string[] = []
    const stoppedDirs: { directoryId: string; adminEmail?: string | null }[] = []

    const apps = new Map<string, Hono>()
    const as = (userId: string) => {
      const hit = apps.get(userId)
      if (hit) return hit
      const app = new Hono()
      app.use("*", async (c, next) => {
        c.set("auth", {
          apiKeyId: "",
          tenantId: TENANT,
          scopes: [],
          mode: "live",
        } as never)
        c.set("user", { userId, orgId: ORG } as never)
        c.set("freshAuth", (async () =>
          fresh ? { status: "fresh" } : { status: "stale" }) as never)
        await next()
      })
      mountIdentity(app, {
        roles: {
          store: { roleOf: async (_t: string, u: string) => ROLES[u] ?? null },
        },
        identity: {
          store: {
            ...identity.store,
            events: async (tenantId: string, { limit }: { limit: number }) =>
              identity.events
                .filter((e) => e.tenantId === tenantId)
                .map((e, i) => ({
                  id: `evt-${i}`,
                  type: e.type,
                  actorUserId: e.actorUserId ?? null,
                  subjectUserId: e.subjectUserId ?? null,
                  connectionId: e.connectionId ?? null,
                  sessionId: e.sessionId ?? null,
                  reason: e.reason ?? null,
                  data: e.data ?? {},
                  createdAt: new Date(2026, 9, 24, 12, 0, i),
                }))
                .reverse()
                .slice(0, limit),
          },
          clerk: memoryClerk().clerk,
          gate: { forget: () => {} },
          protocols: ["test"],
          deprovision: {},
          scim: {
            store: dirs.store,
            baseUrl: (id: string) => `https://api.test/scim/v2/${id}`,
            kick: async () => {},
            schedule: async () => {},
            google: {
              serviceAccount: configured
                ? { clientEmail: sa.clientEmail, clientId: sa.clientId }
                : null,
              scopes: GOOGLE_DIRECTORY_SCOPES,
              checkAccess: (input) =>
                checkGoogleDirectoryAccess(
                  { tokens, fetch: net.fetch, store: dirs.store },
                  input,
                ),
              schedulePull: async (_t, directoryId) => {
                pullsScheduled.push(directoryId)
              },
              stopChannels: async (_t, directoryId, adminEmail) => {
                stoppedDirs.push({
                  directoryId,
                  ...(adminEmail !== undefined ? { adminEmail } : {}),
                })
                await stopGoogleWatchChannels(
                  { store: dirs.store, tokens, fetch: net.fetch, log },
                  {
                    tenantId: TENANT,
                    directoryId,
                    ...(adminEmail !== undefined ? { adminEmail } : {}),
                  },
                )
              },
            } satisfies GoogleConsoleDeps,
          },
          log,
        },
      } as unknown as ConsoleDeps)
      apps.set(userId, app)
      return app
    }

    const call = (userId: string, method: string, path: string, body?: unknown) =>
      as(userId).request(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })

    return {
      call,
      dirs,
      identity,
      net,
      pullsScheduled,
      stoppedDirs,
      setDomains: (next: string[]) => {
        dirs.domains.splice(0, dirs.domains.length, ...next)
      },
      setFresh: (next: boolean) => {
        fresh = next
      },
    }
  }

  it("refuses enabling when GOOGLE_DIRECTORY_SERVICE_ACCOUNT is unset, explains why, and never crashes", async () => {
    const w = buildConsole({ serviceAccountConfigured: false })

    const listRes = await w.call("user_admin", "GET", "/identity/directories")
    expect(listRes.status).toBe(200)
    const listBody = await readBody(listRes)
    expect(listBody.google).toMatchObject({
      available: false,
      unavailableReason: GOOGLE_UNAVAILABLE_REASON,
      clientEmail: null,
      clientId: null,
    })

    const createdRes = await w.call("user_owner", "POST", "/identity/directories", {
      name: "Google Workspace",
      provider: "google",
      adminEmail: "admin@acme.test",
      domain: "acme.test",
    })
    expect(createdRes.status).toBe(201)
    const created = await readBody(createdRes)
    expect(created.enabled).toBe(false)
    expect(created.google.available).toBe(false)
    expect(created.google.unavailableReason).toContain(
      "GOOGLE_DIRECTORY_SERVICE_ACCOUNT",
    )

    const enableRes = await w.call(
      "user_owner",
      "PATCH",
      `/identity/directories/${created.id}`,
      { enabled: true },
    )
    expect(enableRes.status).toBe(422)
    const enableErr = await readBody(enableRes)
    expect(enableErr.message).toContain("GOOGLE_DIRECTORY_SERVICE_ACCOUNT")
    expect(w.dirs.directories.get(created.id)!.enabled).toBe(false)
    expect(w.pullsScheduled).toEqual([])

    const checkRes = await w.call(
      "user_admin",
      "POST",
      `/identity/directories/${created.id}/check`,
    )
    expect(checkRes.status).toBe(200)
    expect(await readBody(checkRes)).toEqual({
      ok: false,
      error: "not_configured",
    })
  })

  it("requires an owner with fresh step-up to set or change adminEmail, domain, or enabled", async () => {
    const w = buildConsole()
    const created = await readBody(
      await w.call("user_owner", "POST", "/identity/directories", {
        name: "Google",
        provider: "google",
      }),
    )
    expect(created.enabled).toBe(false)

    // Admin (`sso:manage`) cannot set or change adminEmail, domain, or enable.
    for (const patch of [
      { adminEmail: "it@acme.test" },
      { domain: "acme.test" },
      { adminEmail: "it@acme.test", domain: "acme.test" },
      { enabled: true },
    ]) {
      const res = await w.call(
        "user_admin",
        "PATCH",
        `/identity/directories/${created.id}`,
        patch,
      )
      expect(res.status).toBe(403)
    }

    // Member cannot even check access or rename.
    expect(
      (await w.call("user_member", "POST", `/identity/directories/${created.id}/check`))
        .status,
    ).toBe(403)

    // Stale step-up blocks even an owner.
    w.setFresh(false)
    expect(
      (
        await w.call("user_owner", "PATCH", `/identity/directories/${created.id}`, {
          adminEmail: "it@acme.test",
          domain: "acme.test",
        })
      ).status,
    ).toBe(403)
    expect(w.dirs.directories.get(created.id)!.adminEmail).toBeNull()
    expect(w.dirs.directories.get(created.id)!.domain).toBeNull()
  })

  it("refuses unproved domains, invalid addresses, non-Google providers, and SCIM tokens on Google directories", async () => {
    const w = buildConsole({ domains: ["acme.test"] })

    // Non-Google directories reject adminEmail/domain on POST and PATCH.
    expect(
      (
        await w.call("user_owner", "POST", "/identity/directories", {
          name: "Okta",
          provider: "okta",
          domain: "acme.test",
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await w.call("user_owner", "PATCH", `/identity/directories/${DIRECTORY}`, {
          adminEmail: "it@acme.test",
        })
      ).status,
    ).toBe(422)
    expect(
      (await w.call("user_admin", "POST", `/identity/directories/${DIRECTORY}/check`))
        .status,
    ).toBe(404)

    // Invalid email, invalid domain, or unproved domain on Google directory.
    for (const bad of [
      { adminEmail: "not-an-email", domain: "acme.test" },
      { adminEmail: "it@acme.test", domain: "not a domain" },
      { adminEmail: "it@acme.test", domain: "unverified.test" },
      // An admin of a company we have not verified for this workspace.
      { adminEmail: "ceo@victim.test", domain: "acme.test" },
    ]) {
      expect(
        (
          await w.call("user_owner", "POST", "/identity/directories", {
            name: "Google",
            provider: "google",
            ...bad,
          })
        ).status,
      ).toBe(422)
    }

    const googleDir = await readBody(
      await w.call("user_owner", "POST", "/identity/directories", {
        name: "Google",
        provider: "google",
      }),
    )

    // Cannot enable before adminEmail and domain are both set.
    expect(
      (
        await w.call("user_owner", "PATCH", `/identity/directories/${googleDir.id}`, {
          enabled: true,
        })
      ).status,
    ).toBe(422)

    // Set valid settings while acme.test is live, then lapse acme.test before enabling.
    expect(
      (
        await w.call("user_owner", "PATCH", `/identity/directories/${googleDir.id}`, {
          adminEmail: "it@acme.test",
          domain: "acme.test",
        })
      ).status,
    ).toBe(200)
    w.setDomains([])
    expect(
      (
        await w.call("user_owner", "PATCH", `/identity/directories/${googleDir.id}`, {
          enabled: true,
        })
      ).status,
    ).toBe(422)

    // Google directories never mint SCIM tokens or accept SCIM bearer requests.
    expect(
      (
        await w.call(
          "user_owner",
          "POST",
          `/identity/directories/${googleDir.id}/tokens`,
          {},
        )
      ).status,
    ).toBe(422)

    const { token, hash } = scimToken("forged-google")
    await w.dirs.store.issueToken(
      TENANT,
      googleDir.id,
      { tokenHash: hash, hint: "i10_scim_forg", createdBy: "u", overlapMs: 0 },
      new Date(),
    )
    await w.dirs.store.updateDirectory(TENANT, googleDir.id, { enabled: true })
    const scimApp = createScimRoutes({
      store: w.dirs.store,
      baseUrl: (id) => `https://api.test/scim/v2/${id}`,
      schedule: async () => {},
      kick: async () => {},
      record: (t, e) => w.identity.store.record(t, e),
      take: fixedWindow(null),
      contextSecret: undefined,
      edgeSecret: EDGE_SECRET,
      log,
    })
    const scimRes = await scimApp.request(`/${googleDir.id}/Users`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(scimRes.status).toBe(403)
  })

  it("reports fixed error codes from check-access and never leaks Google's raw error message", async () => {
    const rawLeak = "GOOGLE_INTERNAL_DELEGATION_ERROR_98765"
    let mode: "unauth" | "scope" | "unknown" = "unauth"
    const w = buildConsole({
      googleHandler: (call) => {
        if (call.url.href === GOOGLE_TOKEN_URL) {
          if (mode === "unauth")
            return jsonResponse(
              {
                error: "unauthorized_client",
                error_description: `Client not authorized: ${rawLeak}`,
              },
              401,
            )
          return jsonResponse({ access_token: "tok_1", expires_in: 3600 })
        }
        if (mode === "scope")
          return jsonResponse(
            {
              error: {
                code: 403,
                message: rawLeak,
                errors: [{ reason: "insufficientPermissions" }],
              },
            },
            403,
          )
        return jsonResponse(
          {
            error: {
              code: 404,
              message: rawLeak,
              errors: [{ reason: "notFound" }],
            },
          },
          404,
        )
      },
    })

    const created = await readBody(
      await w.call("user_owner", "POST", "/identity/directories", {
        name: "Google",
        provider: "google",
        adminEmail: "admin@acme.test",
        domain: "acme.test",
      }),
    )

    for (const [nextMode, expected] of [
      ["unauth", "delegation_missing"],
      ["scope", "missing_scope"],
      ["unknown", "unknown_customer"],
    ] as const) {
      mode = nextMode
      const res = await w.call(
        "user_admin",
        "POST",
        `/identity/directories/${created.id}/check`,
      )
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toContain(rawLeak)
      expect(JSON.parse(text)).toEqual({ ok: false, error: expected })
    }
    expect(JSON.stringify(w.identity.events)).not.toContain(rawLeak)
  })

  it("audits Google settings, checks maxResults=1, schedules a pull on enable, and stops channels on disable", async () => {
    const w = buildConsole()
    const created = await readBody(
      await w.call("user_owner", "POST", "/identity/directories", {
        name: "Google Workspace",
        provider: "google",
      }),
    )
    expect(created).toMatchObject({
      provider: "google",
      enabled: false,
      baseUrl: null,
      adminEmail: null,
      domain: null,
      google: {
        available: true,
        clientEmail: sa.clientEmail,
        clientId: sa.clientId,
        scopes: GOOGLE_DIRECTORY_SCOPES,
      },
    })

    const configured = await readBody(
      await w.call("user_owner", "PATCH", `/identity/directories/${created.id}`, {
        adminEmail: " Admin@Acme.Test ",
        domain: " ACME.TEST ",
      }),
    )
    expect(configured).toMatchObject({
      adminEmail: "admin@acme.test",
      domain: "acme.test",
      enabled: false,
    })

    const check = await readBody(
      await w.call("user_admin", "POST", `/identity/directories/${created.id}/check`),
    )
    expect(check).toEqual({ ok: true })
    const listCall = w.net.calls.find((c) => c.url.pathname.endsWith("/users"))
    expect(listCall?.url.searchParams.get("customer")).toBe("my_customer")
    expect(listCall?.url.searchParams.get("domain")).toBe("acme.test")
    expect(listCall?.url.searchParams.get("maxResults")).toBe("1")

    const enabled = await readBody(
      await w.call("user_owner", "PATCH", `/identity/directories/${created.id}`, {
        enabled: true,
      }),
    )
    expect(enabled.enabled).toBe(true)
    expect(w.pullsScheduled).toEqual([created.id])

    const disabled = await readBody(
      await w.call("user_admin", "PATCH", `/identity/directories/${created.id}`, {
        enabled: false,
      }),
    )
    expect(disabled.enabled).toBe(false)
    expect(w.stoppedDirs).toEqual([
      { directoryId: created.id, adminEmail: "admin@acme.test" },
    ])

    const updatedEvents = w.identity.events.filter(
      (e) => e.type === "directory.updated",
    )
    expect(updatedEvents[0]).toMatchObject({
      actorUserId: "user_owner",
      data: {
        directoryId: created.id,
        from: { adminEmail: null, domain: null },
        to: { adminEmail: "admin@acme.test", domain: "acme.test" },
      },
    })
  })

  it("diagnoses delegation_missing vs scope_missing, classifies admin_not_found and subject_not_admin from Google's exact live bodies, and never leaks raw Google text", async () => {
    for (const code of [
      "admin_not_found",
      "subject_not_admin",
      "delegation_missing",
      "scope_missing",
      "large_drop",
    ] as const) {
      expect(GOOGLE_DIRECTORY_ERRORS).toContain(code)
    }

    const [userScope, groupScope] = GOOGLE_DIRECTORY_SCOPES
    const rawUnauthDesc =
      "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested."
    const rawInvalidEmailDesc = "Invalid email or User ID"
    const rawForbiddenMsg = "Not Authorized to access this resource/api"

    type LiveMode =
      | "delegation_missing"
      | "scope_missing"
      | "neither_probe_503"
      | "neither_all_200"
      | "admin_not_found"
      | "subject_not_admin"
    let mode: LiveMode = "delegation_missing"
    const requestedScopes: string[] = []

    const decodeAssertionScope = (body: string): string => {
      const assertion = new URLSearchParams(body).get("assertion") ?? ""
      const [, payloadB64] = assertion.split(".")
      const payload = JSON.parse(
        Buffer.from(payloadB64!, "base64url").toString("utf8"),
      ) as { scope: string }
      return payload.scope
    }

    const w = buildConsole({
      googleHandler: (call) => {
        if (call.url.href === GOOGLE_TOKEN_URL) {
          const scope = decodeAssertionScope(call.body)
          requestedScopes.push(scope)
          if (mode === "delegation_missing") {
            return jsonResponse(
              { error: "unauthorized_client", error_description: rawUnauthDesc },
              401,
            )
          }
          if (mode === "scope_missing") {
            if (scope === userScope) {
              return jsonResponse({ access_token: "tok_single_user", expires_in: 3600 })
            }
            return jsonResponse(
              { error: "unauthorized_client", error_description: rawUnauthDesc },
              401,
            )
          }
          if (mode === "neither_probe_503") {
            if (scope.includes(" ")) {
              return jsonResponse(
                { error: "unauthorized_client", error_description: rawUnauthDesc },
                401,
              )
            }
            return jsonResponse({ error: "backend_failure" }, 503)
          }
          if (mode === "neither_all_200") {
            if (scope.includes(" ")) {
              return jsonResponse(
                { error: "unauthorized_client", error_description: rawUnauthDesc },
                401,
              )
            }
            return jsonResponse({ access_token: "tok_probe", expires_in: 3600 })
          }
          if (mode === "admin_not_found") {
            return jsonResponse(
              { error: "invalid_grant", error_description: rawInvalidEmailDesc },
              400,
            )
          }
          return jsonResponse({ access_token: "tok_member", expires_in: 3600 })
        }

        // Directory API `users.list` for `subject_not_admin`.
        return jsonResponse(
          {
            error: {
              code: 403,
              message: rawForbiddenMsg,
              errors: [{ reason: "forbidden" }],
            },
          },
          403,
        )
      },
    })

    const created = await readBody(
      await w.call("user_owner", "POST", "/identity/directories", {
        name: "Google Live Cases",
        provider: "google",
        adminEmail: "admin@acme.test",
        domain: "acme.test",
      }),
    )
    await w.call("user_owner", "PATCH", `/identity/directories/${created.id}`, {
      enabled: true,
    })

    const assertNoRawGoogleText = (text: string) => {
      expect(text).not.toContain(rawUnauthDesc)
      expect(text).not.toContain("Client is unauthorized to retrieve access tokens")
      expect(text).not.toContain(rawInvalidEmailDesc)
      expect(text).not.toContain(rawForbiddenMsg)
      expect(text).not.toContain("Not Authorized to access this resource")
    }

    // 1. No delegation: combined request fails + both single-scope probes fail -> `delegation_missing`.
    mode = "delegation_missing"
    requestedScopes.length = 0
    const delRes = await w.call(
      "user_admin",
      "POST",
      `/identity/directories/${created.id}/check`,
    )
    const delText = await delRes.text()
    assertNoRawGoogleText(delText)
    expect(JSON.parse(delText)).toEqual({ ok: false, error: "delegation_missing" })
    expect(requestedScopes).toEqual([
      GOOGLE_DIRECTORY_SCOPES.join(" "),
      userScope,
      groupScope,
    ])

    // 2. Partial scopes: `user.readonly` succeeds, `group.readonly` fails -> `scope_missing` with failing scope URL.
    mode = "scope_missing"
    requestedScopes.length = 0
    const scopeRes = await w.call(
      "user_admin",
      "POST",
      `/identity/directories/${created.id}/check`,
    )
    const scopeText = await scopeRes.text()
    assertNoRawGoogleText(scopeText)
    expect(JSON.parse(scopeText)).toEqual({
      ok: false,
      error: "scope_missing",
      missingScopes: [groupScope],
    })
    expect(requestedScopes).toEqual([
      GOOGLE_DIRECTORY_SCOPES.join(" "),
      userScope,
      groupScope,
    ])

    // Calling check again must NOT reuse the single-scope `tok_single_user` token from cache.
    requestedScopes.length = 0
    await w.call("user_admin", "POST", `/identity/directories/${created.id}/check`)
    expect(requestedScopes[0]).toBe(GOOGLE_DIRECTORY_SCOPES.join(" "))

    // Pulling in `scope_missing` mode records `missingScopes` and surfaces `lastSyncDetail` on GET.
    const pullTokens = createGoogleTokenSource({
      serviceAccount: sa,
      fetch: w.net.fetch,
    })
    const scopePull = await pullGoogleDirectory(
      {
        store: w.dirs.store,
        tokens: pullTokens,
        fetch: w.net.fetch,
        schedule: async () => {},
        record: (t, e) => w.identity.store.record(t, e),
        log,
      },
      { tenantId: TENANT, directoryId: created.id },
    )
    expect(scopePull).toEqual({
      outcome: "failed",
      error: "scope_missing",
      retryable: false,
      missingScopes: [groupScope],
    })
    const getAfterScopeRes = await w.call(
      "user_admin",
      "GET",
      `/identity/directories/${created.id}`,
    )
    const getAfterScopeText = await getAfterScopeRes.text()
    assertNoRawGoogleText(getAfterScopeText)
    expect(JSON.parse(getAfterScopeText)).toMatchObject({
      lastSyncStatus: "failed",
      lastSyncError: "scope_missing",
      lastSyncDetail: { missingScopes: [groupScope] },
    })

    // 3. Fallback `unauthorized_client` when single-scope probes fit neither case.
    for (const fallbackMode of ["neither_probe_503", "neither_all_200"] as const) {
      mode = fallbackMode
      const fbRes = await w.call(
        "user_admin",
        "POST",
        `/identity/directories/${created.id}/check`,
      )
      const fbText = await fbRes.text()
      assertNoRawGoogleText(fbText)
      expect(JSON.parse(fbText)).toEqual({ ok: false, error: "unauthorized_client" })
    }

    // 4. Subject email does not exist -> `admin_not_found` (single token call, no scope probes).
    mode = "admin_not_found"
    requestedScopes.length = 0
    const adminRes = await w.call(
      "user_admin",
      "POST",
      `/identity/directories/${created.id}/check`,
    )
    const adminText = await adminRes.text()
    assertNoRawGoogleText(adminText)
    expect(JSON.parse(adminText)).toEqual({ ok: false, error: "admin_not_found" })
    expect(requestedScopes).toEqual([GOOGLE_DIRECTORY_SCOPES.join(" ")])

    const adminPull = await pullGoogleDirectory(
      {
        store: w.dirs.store,
        tokens: pullTokens,
        fetch: w.net.fetch,
        schedule: async () => {},
        record: (t, e) => w.identity.store.record(t, e),
        log,
      },
      { tenantId: TENANT, directoryId: created.id },
    )
    expect(adminPull).toEqual({
      outcome: "failed",
      error: "admin_not_found",
      retryable: false,
    })

    // 5. Subject exists, not an admin -> token 200, first `users.list` 403 `reason: "forbidden"` -> `subject_not_admin`.
    mode = "subject_not_admin"
    const nonAdminRes = await w.call(
      "user_admin",
      "POST",
      `/identity/directories/${created.id}/check`,
    )
    const nonAdminText = await nonAdminRes.text()
    assertNoRawGoogleText(nonAdminText)
    expect(JSON.parse(nonAdminText)).toEqual({ ok: false, error: "subject_not_admin" })

    const nonAdminPull = await pullGoogleDirectory(
      {
        store: w.dirs.store,
        tokens: pullTokens,
        fetch: w.net.fetch,
        schedule: async () => {},
        record: (t, e) => w.identity.store.record(t, e),
        log,
      },
      { tenantId: TENANT, directoryId: created.id },
    )
    expect(nonAdminPull).toEqual({
      outcome: "failed",
      error: "subject_not_admin",
      retryable: false,
    })

    assertNoRawGoogleText(JSON.stringify(w.identity.events))
    assertNoRawGoogleText(JSON.stringify([...w.dirs.directories.values()]))
  })
})

// ── 4. The pull, incomplete-pull safety, idempotency & downstream pipeline ──

describe("pullGoogleDirectory: incomplete-pull safety first, then mapping, idempotency and deletions", () => {
  const sa = parseGoogleServiceAccount(SERVICE_ACCOUNT_JSON)

  function syncWorld(opts: {
    domains?: string[]
    adminEmail?: string
    domain?: string
    owners?: string[]
    users?: ReturnType<typeof user>[]
    googleHandler: (call: RecordedCall) => Response | Promise<Response>
  }) {
    const domains = opts.domains ?? ["acme.test"]
    const dirs = memoryDirectories({
      domains,
      directories: [
        {
          id: DIRECTORY,
          name: "Acme Google",
          provider: "google",
          enabled: true,
          adminEmail: opts.adminEmail ?? "admin@acme.test",
          domain: opts.domain ?? "acme.test",
        },
      ],
    })
    const identity = memoryStore({
      connections: [connection({ id: CONNECTION, status: "active" })],
      live: { [CONNECTION]: domains },
    })
    const clerk = memoryClerk({ users: opts.users ?? [] })
    const prov = memoryProvisioning(clerk)
    const members = new Set<string>(opts.owners ?? [])
    const roles = rolesDeps({
      rows: (opts.owners ?? []).map((u) => roleRow(u, "owner")),
      tenants: { [ORG]: ACME.tenantId },
      clerk: {
        create: async (_o, userId) => {
          if (members.has(userId)) return { outcome: "already_member" }
          members.add(userId)
          return { outcome: "created", membershipId: `mem_${userId}` }
        },
      },
    })
    const mail = memoryMail()
    const deprovision: DeprovisionDeps = {
      store: identity.store,
      clerk: clerk.clerk,
      log,
      mail: mail.lifecycle,
      workspaceOrg: (t) => identity.store.workspaceOrg(t),
      authorize: async () => "ok",
      removeMembership: async ({ userId }) => {
        const owners = roles.rows().filter((r) => r.role === "owner")
        if (owners.length === 1 && owners[0]!.userId === userId) return "last_owner"
        members.delete(userId)
        return "removed"
      },
    }
    const applyDeps: DirectoryDeps = {
      store: dirs.store,
      identity: identity.store,
      clerk: clerk.clerk,
      provisioning: prov.provisioning,
      deprovision,
      mail: mail.deps,
      isMember: async (_o, userId) => members.has(userId),
      seats: async () => ({ full: false }),
      join: async ({ orgId, userId, role }) =>
        addMember(roles.d, { orgId, userId, role, source: "scim" }),
      isExempt: async (_t, userId) => {
        const role = await roles.d.store.roleOf(ACME.tenantId, userId)
        return role === "owner" || role === "admin"
      },
      forget: () => {},
      log,
      now: () => new Date("2026-10-24T12:00:00Z"),
    }

    const net = fakeGoogleFetch(opts.googleHandler)
    const tokens = createGoogleTokenSource({ serviceAccount: sa, fetch: net.fetch })
    const scheduledIds: string[] = []

    const drainOutbox = async () => {
      for (const entry of [...dirs.outbox]) {
        if (entry.appliedAt) continue
        await applyDirectoryUser(applyDeps, {
          tenantId: TENANT,
          directoryUserId: entry.directoryUserId,
        })
      }
    }

    return {
      dirs,
      identity,
      clerk,
      members,
      net,
      tokens,
      scheduledIds,
      drainOutbox,
      pull: (bounds?: Parameters<typeof pullGoogleDirectory>[0]["bounds"]) =>
        pullGoogleDirectory(
          {
            store: dirs.store,
            tokens,
            fetch: net.fetch,
            schedule: async (_t, entries) => {
              scheduledIds.push(...entries.map((e) => e.directoryUserId))
            },
            record: (t, e) => identity.store.record(t, e),
            log,
            ...(bounds ? { bounds } : {}),
            now: () => new Date("2026-10-24T12:05:00Z"),
          },
          { tenantId: TENANT, directoryId: DIRECTORY },
        ),
    }
  }

  it("never deletes or modifies anybody when any page fails, times out, loops, exceeds bounds, or loses domain proof", async () => {
    type Scenario =
      | "seed"
      | "users_page2_500"
      | "users_page2_timeout"
      | "users_page2_malformed"
      | "users_200_error_envelope"
      | "groups_fail"
      | "members_fail"
      | "page_loop"
      | "cap_users"
      | "cap_groups"
    let scenario: Scenario = "seed"

    const w = syncWorld({
      googleHandler: (call) => {
        if (call.url.href === GOOGLE_TOKEN_URL)
          return jsonResponse({ access_token: "tok_pull", expires_in: 3600 })

        const path = call.url.pathname
        const page = call.url.searchParams.get("pageToken")

        if (scenario === "seed") {
          if (path.endsWith("/users"))
            return jsonResponse({
              users: [
                {
                  id: "g_ada",
                  primaryEmail: "ada@acme.test",
                  name: { givenName: "Ada", familyName: "Lovelace" },
                },
                {
                  id: "g_grace",
                  primaryEmail: "grace@acme.test",
                  name: { givenName: "Grace", familyName: "Hopper" },
                },
              ],
            })
          if (path.endsWith("/groups"))
            return jsonResponse({
              groups: [{ id: "grp_eng", email: "eng@acme.test", name: "Engineers" }],
            })
          return jsonResponse({
            members: [{ id: "g_ada", type: "USER", status: "ACTIVE" }],
          })
        }

        if (scenario === "users_page2_500") {
          if (path.endsWith("/users") && !page)
            return jsonResponse({
              users: [
                {
                  id: "g_ada",
                  primaryEmail: "ada@acme.test",
                  name: { givenName: "Ada", familyName: "Lovelace" },
                },
              ],
              nextPageToken: "p2",
            })
          return jsonResponse({ error: { code: 500, message: "GOOGLE_BOOM" } }, 500)
        }

        if (scenario === "users_page2_timeout") {
          if (path.endsWith("/users") && !page)
            return jsonResponse({ users: [], nextPageToken: "p2" })
          const err = new Error("timed out")
          err.name = "TimeoutError"
          throw err
        }

        if (scenario === "users_page2_malformed") {
          if (path.endsWith("/users") && !page)
            return jsonResponse({ users: [], nextPageToken: "p2" })
          return new Response("{truncated-json", { status: 200 })
        }

        if (scenario === "users_200_error_envelope") {
          return jsonResponse({ error: { code: 403, message: "sneaky envelope" } }, 200)
        }

        if (scenario === "groups_fail") {
          if (path.endsWith("/users")) return jsonResponse({})
          return jsonResponse({ error: { code: 503 } }, 503)
        }

        if (scenario === "members_fail") {
          if (path.endsWith("/users")) return jsonResponse({})
          if (path.endsWith("/groups"))
            return jsonResponse({
              groups: [{ id: "grp_eng", email: "eng@acme.test", name: "Engineers" }],
            })
          return jsonResponse({ error: { code: 502 } }, 502)
        }

        if (scenario === "page_loop") {
          return jsonResponse({ users: [], nextPageToken: "same-token" })
        }

        if (scenario === "cap_users") {
          return jsonResponse({
            users: [
              { id: "u1", primaryEmail: "u1@acme.test" },
              { id: "u2", primaryEmail: "u2@acme.test" },
            ],
          })
        }

        if (path.endsWith("/users")) return jsonResponse({})
        return jsonResponse({
          groups: [
            { id: "g1", email: "g1@acme.test", name: "G1" },
            { id: "g2", email: "g2@acme.test", name: "G2" },
          ],
        })
      },
    })

    // Seed two real provisioned users and one group.
    const seeded = await w.pull()
    expect(seeded).toEqual({
      outcome: "ok",
      users: { created: 2, updated: 0, deleted: 0, unchanged: 0 },
      groups: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
    })
    await w.drainOutbox()
    expect(w.members.size).toBe(2)

    const outboxBefore = w.dirs.outbox.length
    const failureCases: {
      mode: Scenario
      bounds?: Parameters<typeof w.pull>[0]
      expectedError: GoogleDirectoryErrorCode
    }[] = [
      { mode: "users_page2_500", expectedError: "unreachable" },
      { mode: "users_page2_timeout", expectedError: "unreachable" },
      { mode: "users_page2_malformed", expectedError: "invalid_response" },
      { mode: "users_200_error_envelope", expectedError: "invalid_response" },
      { mode: "groups_fail", expectedError: "unreachable" },
      { mode: "members_fail", expectedError: "unreachable" },
      { mode: "page_loop", expectedError: "invalid_response" },
      { mode: "cap_users", bounds: { maxUsers: 1 }, expectedError: "too_many_users" },
      {
        mode: "cap_groups",
        bounds: { maxGroups: 1 },
        expectedError: "too_many_groups",
      },
    ]

    for (const c of failureCases) {
      scenario = c.mode
      const res = await w.pull(c.bounds)
      expect(res.outcome).toBe("failed")
      if (res.outcome === "failed") expect(res.error).toBe(c.expectedError)

      const dir = w.dirs.directories.get(DIRECTORY)!
      expect(dir.lastSyncStatus).toBe("failed")
      expect(dir.lastSyncError).toBe(c.expectedError)

      // Zero deletions, zero new outbox entries, both Clerk members still standing.
      expect(w.dirs.users.filter((u) => u.deletedAt === null)).toHaveLength(2)
      expect(w.dirs.groups).toHaveLength(1)
      expect(w.dirs.outbox).toHaveLength(outboxBefore)
      expect(w.members.size).toBe(2)
    }

    // Lapsing the workspace domain also aborts without deleting anyone.
    w.dirs.domains.splice(0, w.dirs.domains.length)
    const lapsed = await w.pull()
    expect(lapsed).toEqual({
      outcome: "failed",
      error: "domain_not_verified",
      retryable: false,
    })
    expect(w.dirs.users.filter((u) => u.deletedAt === null)).toHaveLength(2)
  })

  it("refuses to impersonate an admin outside the workspace's proved domains, and never believes an empty pull over a populated directory", async () => {
    let mode: "seed" | "empty" = "seed"
    const w = syncWorld({
      googleHandler: (call) => {
        if (call.url.href === GOOGLE_TOKEN_URL)
          return jsonResponse({ access_token: "tok_e", expires_in: 3600 })
        if (mode === "empty") return jsonResponse({})
        if (call.url.pathname.endsWith("/users"))
          return jsonResponse({
            users: [
              {
                id: "g_ada",
                primaryEmail: "ada@acme.test",
                name: { givenName: "Ada", familyName: "Lovelace" },
              },
            ],
          })
        return jsonResponse({})
      },
    })

    // The admin we would impersonate belongs to a domain nobody here proved.
    w.dirs.directories.get(DIRECTORY)!.adminEmail = "ceo@victim.test"
    const callsBefore = w.net.calls.length
    expect(await w.pull()).toEqual({
      outcome: "failed",
      error: "domain_not_verified",
      retryable: false,
    })
    expect(w.net.calls).toHaveLength(callsBefore)
    w.dirs.directories.get(DIRECTORY)!.adminEmail = "admin@acme.test"

    expect((await w.pull()).outcome).toBe("ok")
    const outboxBefore = w.dirs.outbox.length

    mode = "empty"
    expect(await w.pull()).toEqual({
      outcome: "failed",
      error: "empty_directory",
      retryable: false,
    })
    expect(w.dirs.users.filter((u) => u.deletedAt === null)).toHaveLength(1)
    expect(w.dirs.outbox).toHaveLength(outboxBefore)
  })

  it("leaves a userName swap alone, reports user_conflict, and never parks anybody on a made-up address", async () => {
    let swapped = false
    const w = syncWorld({
      googleHandler: (call) => {
        if (call.url.href === GOOGLE_TOKEN_URL)
          return jsonResponse({ access_token: "tok_s", expires_in: 3600 })
        if (!call.url.pathname.endsWith("/users")) return jsonResponse({})
        const name = { givenName: "N", familyName: "N" }
        return jsonResponse({
          users: [
            {
              id: "g_a",
              primaryEmail: swapped ? "bob@acme.test" : "ada@acme.test",
              name,
            },
            {
              id: "g_b",
              primaryEmail: swapped ? "ada@acme.test" : "bob@acme.test",
              name,
            },
          ],
        })
      },
    })
    expect((await w.pull()).outcome).toBe("ok")
    const outboxBefore = w.dirs.outbox.length

    swapped = true
    expect(await w.pull()).toEqual({
      outcome: "failed",
      error: "user_conflict",
      retryable: false,
    })
    const names = w.dirs.users
      .filter((u) => u.deletedAt === null)
      .map((u) => u.userName)
    expect(names.sort()).toEqual(["ada@acme.test", "bob@acme.test"])
    expect(w.dirs.outbox).toHaveLength(outboxBefore)
  })

  it("maps users, aliases, suspended accounts, missing names (profile_incomplete), role_exempt owners, skips unchanged rows, and deletes removed rows on a complete pull", async () => {
    const ownerClerk = user({
      id: "user_boss",
      firstName: "Boss",
      lastName: "Owner",
      primaryEmailId: "idn_boss",
      emails: [{ id: "idn_boss", address: "boss@acme.test", verified: true }],
    })

    let phase: "initial" | "unchanged_reordered" | "suspend_and_remove" = "initial"

    const initialUsersPage1 = [
      {
        id: "goog_ada",
        primaryEmail: "Ada@Acme.Test",
        suspended: false,
        name: { givenName: "Ada", familyName: "Lovelace", fullName: "Ada Lovelace" },
        aliases: ["ada.alias@acme.test"],
        nonEditableAliases: ["ada@acme.test.google-a.com"],
        emails: [{ address: "ada@acme.test", primary: true, type: "work" }],
      },
      {
        id: "goog_noname",
        primaryEmail: "incomplete@acme.test",
        suspended: false,
        name: { givenName: "", familyName: null },
      },
    ]
    const initialUsersPage2 = [
      {
        id: "goog_alan",
        primaryEmail: "alan@acme.test",
        suspended: false,
        name: { givenName: "Alan", familyName: "Turing" },
      },
      {
        id: "goog_boss",
        primaryEmail: "boss@acme.test",
        suspended: false,
        name: { givenName: "Boss", familyName: "Owner" },
      },
    ]

    const w = syncWorld({
      owners: ["user_boss"],
      users: [ownerClerk],
      googleHandler: (call) => {
        if (call.url.href === GOOGLE_TOKEN_URL)
          return jsonResponse({ access_token: "tok_sync", expires_in: 3600 })

        const path = call.url.pathname
        const page = call.url.searchParams.get("pageToken")

        if (phase === "initial" || phase === "unchanged_reordered") {
          const wrap = (v: unknown) =>
            phase === "unchanged_reordered" ? reverseKeys(v) : v
          if (path.endsWith("/users")) {
            expect(call.url.searchParams.get("customer")).toBe("my_customer")
            expect(call.url.searchParams.has("domain")).toBe(false)
            if (!page)
              return jsonResponse(
                wrap({ users: initialUsersPage1, nextPageToken: "u_p2" }),
              )
            return jsonResponse(wrap({ users: initialUsersPage2 }))
          }
          if (path.endsWith("/groups")) {
            expect(call.url.searchParams.get("customer")).toBe("my_customer")
            expect(call.url.searchParams.has("domain")).toBe(false)
            return jsonResponse(
              wrap({
                groups: [
                  { id: "grp_core", email: "core@acme.test", name: "Core" },
                  { id: "grp_all", email: "all@acme.test", name: "All Eng" },
                ],
              }),
            )
          }
          if (path.includes("/groups/grp_core/members")) {
            return jsonResponse(
              wrap({
                members: [
                  { id: "goog_ada", type: "USER", status: "ACTIVE" },
                  { id: "goog_alan", type: "USER", status: "SUSPENDED" },
                ],
              }),
            )
          }
          return jsonResponse(
            wrap({
              members: [
                { id: "grp_core", type: "GROUP", status: "ACTIVE" },
                { email: "ALAN@ACME.TEST", type: "USER", status: "ACTIVE" },
              ],
            }),
          )
        }

        // Phase 3: Ada is suspended, Alan is deleted from Google, grp_core is deleted.
        if (path.endsWith("/users")) {
          return jsonResponse({
            users: [
              {
                id: "goog_ada",
                primaryEmail: "ada@acme.test",
                suspended: true,
                name: { givenName: "Ada", familyName: "Lovelace" },
                aliases: ["ada.alias@acme.test"],
                nonEditableAliases: ["ada@acme.test.google-a.com"],
              },
              initialUsersPage1[1],
              initialUsersPage2[1],
            ],
          })
        }
        if (path.endsWith("/groups")) {
          return jsonResponse({
            groups: [{ id: "grp_all", email: "all@acme.test", name: "All Eng" }],
          })
        }
        return jsonResponse({
          members: [
            { id: "goog_ada", type: "USER", status: "ACTIVE" },
            { id: "goog_boss", type: "USER", status: "ACTIVE" },
          ],
        })
      },
    })

    // 1. Initial paginated pull.
    const first = await w.pull({ pageSize: 2 })
    expect(first).toEqual({
      outcome: "ok",
      users: { created: 4, updated: 0, deleted: 0, unchanged: 0 },
      groups: { created: 2, updated: 0, deleted: 0, unchanged: 0 },
    })
    const dirAfterFirst = w.dirs.directories.get(DIRECTORY)!
    expect(dirAfterFirst.lastSyncStatus).toBe("ok")
    expect(dirAfterFirst.lastSyncError).toBeNull()

    // Check Ada's StoredUser mapping (externalId, primary email, aliases).
    const adaRow = w.dirs.users.find((u) => u.externalId === "goog_ada")!
    expect(adaRow).toMatchObject({
      userName: "ada@acme.test",
      email: "ada@acme.test",
      givenName: "Ada",
      familyName: "Lovelace",
      displayName: "Ada Lovelace",
      active: true,
    })
    const adaEmails = (adaRow.resource.emails as { value: string }[]).map(
      (e) => e.value,
    )
    expect(adaEmails).toEqual([
      "ada@acme.test",
      "ada.alias@acme.test",
      "ada@acme.test.google-a.com",
    ])

    // Apply outbox through the real downstream SCIM apply pipeline.
    await w.drainOutbox()

    // Incomplete name -> `profile_incomplete` downstream, no Clerk user created for them.
    const incompleteRow = w.dirs.users.find((u) => u.externalId === "goog_noname")!
    expect(incompleteRow.conflict).toBe("profile_incomplete")
    expect(incompleteRow.clerkUserId).toBeNull()

    // Unmanaged workspace owner -> `role_exempt`, never linked as managed.
    const bossRow = w.dirs.users.find((u) => u.externalId === "goog_boss")!
    expect(bossRow.conflict).toBe("role_exempt")
    expect(await w.identity.store.managedByUser("user_boss")).toBeNull()

    // Ada and Alan are provisioned in Clerk and added to the workspace.
    const alanRow = w.dirs.users.find((u) => u.externalId === "goog_alan")!
    expect(adaRow.clerkUserId).not.toBeNull()
    expect(alanRow.clerkUserId).not.toBeNull()
    expect(w.members.has(adaRow.clerkUserId!)).toBe(true)
    expect(w.members.has(alanRow.clerkUserId!)).toBe(true)

    // Nested group `grp_all` resolved `grp_core` (Ada) + `ALAN@ACME.TEST` (Alan), skipping suspended group member Alan on grp_core.
    const adaGroups = await w.dirs.store.personGroups(TENANT, adaRow.clerkUserId!)
    expect(adaGroups.map((g) => g.displayName).sort()).toEqual(["All Eng", "Core"])
    const alanGroups = await w.dirs.store.personGroups(TENANT, alanRow.clerkUserId!)
    expect(alanGroups.map((g) => g.displayName)).toEqual(["All Eng"])

    // 2. Second pull with identical data (and reversed JSON key order, simulating jsonb): ZERO writes!
    for (const u of w.dirs.users)
      u.resource = reverseKeys(u.resource) as Record<string, unknown>
    for (const g of w.dirs.groups)
      g.resource = reverseKeys(g.resource) as Record<string, unknown>
    const outboxCountAfterFirst = w.dirs.outbox.length
    const auditCountAfterFirst = w.dirs.events.length

    phase = "unchanged_reordered"
    const second = await w.pull({ pageSize: 2 })
    expect(second).toEqual({
      outcome: "ok",
      users: { created: 0, updated: 0, deleted: 0, unchanged: 4 },
      groups: { created: 0, updated: 0, deleted: 0, unchanged: 2 },
    })
    expect(w.dirs.outbox).toHaveLength(outboxCountAfterFirst)
    expect(w.dirs.events).toHaveLength(auditCountAfterFirst)

    // 3. Complete pull where Ada is suspended (`active: false`), Alan is removed, and `grp_core` is removed.
    phase = "suspend_and_remove"
    const third = await w.pull({ pageSize: 2 })
    expect(third).toEqual({
      outcome: "ok",
      users: { created: 0, updated: 1, deleted: 1, unchanged: 2 },
      groups: { created: 0, updated: 1, deleted: 1, unchanged: 0 },
    })
    expect(w.dirs.users.find((u) => u.id === adaRow.id)!.active).toBe(false)
    expect(w.dirs.users.find((u) => u.id === alanRow.id)!.deletedAt).not.toBeNull()
    expect(w.dirs.groups.map((g) => g.externalId)).toEqual(["grp_all"])

    await w.drainOutbox()
    // Both suspended Ada and deleted Alan were deprovisioned from workspace membership!
    expect(w.members.has(adaRow.clerkUserId!)).toBe(false)
    expect(w.members.has(alanRow.clerkUserId!)).toBe(false)

    // Archived Google user also maps to `active: false`.
    expect(
      mapGoogleUser({
        id: "g_arch",
        primaryEmail: "arch@acme.test",
        archived: true,
        name: { givenName: "Arch", familyName: "User" },
      }).active,
    ).toBe(false)
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    )
  })

  it("keeps a person renamed between two proved domains (same Google id, alias on old domain) without deprovisioning", async () => {
    let renamed = false
    const w = syncWorld({
      domains: ["i10.tech", "gw2.i10.tech"],
      adminEmail: "admin@i10.tech",
      domain: "i10.tech",
      googleHandler: (call) => {
        if (call.url.href === GOOGLE_TOKEN_URL)
          return jsonResponse({ access_token: "tok_rename", expires_in: 3600 })
        if (call.url.pathname.endsWith("/users")) {
          expect(call.url.searchParams.get("customer")).toBe("my_customer")
          expect(call.url.searchParams.has("domain")).toBe(false)
          return jsonResponse({
            users: [
              {
                id: "g_admin",
                primaryEmail: "admin@i10.tech",
                name: { givenName: "Admin", familyName: "One" },
              },
              renamed
                ? {
                    id: "g_mover",
                    primaryEmail: "mover@gw2.i10.tech",
                    aliases: ["mover@i10.tech"],
                    name: { givenName: "Mo", familyName: "Mover" },
                  }
                : {
                    id: "g_mover",
                    primaryEmail: "mover@i10.tech",
                    name: { givenName: "Mo", familyName: "Mover" },
                  },
            ],
          })
        }
        if (call.url.pathname.endsWith("/groups")) {
          expect(call.url.searchParams.get("customer")).toBe("my_customer")
          expect(call.url.searchParams.has("domain")).toBe(false)
          return jsonResponse({
            groups: [{ id: "grp_eng", email: "eng@i10.tech", name: "Engineering" }],
          })
        }
        return jsonResponse({
          members: [{ id: "g_mover", type: "USER", status: "ACTIVE" }],
        })
      },
    })

    expect(await w.pull()).toEqual({
      outcome: "ok",
      users: { created: 2, updated: 0, deleted: 0, unchanged: 0 },
      groups: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
    })
    await w.drainOutbox()

    const beforeMover = w.dirs.users.find((u) => u.externalId === "g_mover")!
    expect(beforeMover.email).toBe("mover@i10.tech")
    expect(beforeMover.clerkUserId).toBeTruthy()
    expect(w.members.has(beforeMover.clerkUserId!)).toBe(true)

    renamed = true
    expect(await w.pull()).toEqual({
      outcome: "ok",
      users: { created: 0, updated: 1, deleted: 0, unchanged: 1 },
      groups: { created: 0, updated: 0, deleted: 0, unchanged: 1 },
    })
    await w.drainOutbox()

    const afterMover = w.dirs.users.find((u) => u.externalId === "g_mover")!
    expect(afterMover.id).toBe(beforeMover.id)
    expect(afterMover.deletedAt).toBeNull()
    expect(afterMover.userName).toBe("mover@gw2.i10.tech")
    expect(afterMover.email).toBe("mover@gw2.i10.tech")
    expect(afterMover.clerkUserId).toBe(beforeMover.clerkUserId)
    expect(afterMover.conflict).toBeNull()
    expect(w.members.has(beforeMover.clerkUserId!)).toBe(true)
  })

  it("uses the proved-domain alias when a kept user's primaryEmail moves to an unproved domain, and drops users only on unproved domains", async () => {
    let phase: "seed" | "moved" = "seed"
    const w = syncWorld({
      domains: ["i10.tech"],
      adminEmail: "admin@i10.tech",
      domain: "i10.tech",
      googleHandler: (call) => {
        if (call.url.href === GOOGLE_TOKEN_URL)
          return jsonResponse({ access_token: "tok_alias", expires_in: 3600 })
        if (!call.url.pathname.endsWith("/users")) return jsonResponse({})
        if (phase === "seed") {
          return jsonResponse({
            users: [
              {
                id: "g_admin",
                primaryEmail: "admin@i10.tech",
                name: { givenName: "Admin", familyName: "One" },
              },
              {
                id: "g_mover",
                primaryEmail: "mover@i10.tech",
                name: { givenName: "Mo", familyName: "Mover" },
              },
            ],
          })
        }
        return jsonResponse({
          users: [
            {
              id: "g_admin",
              primaryEmail: "admin@i10.tech",
              name: { givenName: "Admin", familyName: "One" },
            },
            {
              id: "g_mover",
              primaryEmail: "mover@gw2.i10.tech",
              aliases: ["mover@i10.tech"],
              emails: [{ address: "mover@gw2.i10.tech", primary: true, type: "work" }],
              name: { givenName: "Mo", familyName: "Mover" },
            },
            {
              id: "g_nonedit",
              primaryEmail: "legacy@gw2.i10.tech",
              nonEditableAliases: ["legacy@i10.tech"],
              name: { givenName: "Lee", familyName: "Legacy" },
            },
            {
              id: "g_unproved",
              primaryEmail: "contractor@outsider.test",
              aliases: ["contractor@gw2.i10.tech"],
              emails: [{ address: "spoof@i10.tech", type: "other" }],
              name: { givenName: "Out", familyName: "Sider" },
            },
          ],
        })
      },
    })

    expect((await w.pull()).outcome).toBe("ok")
    await w.drainOutbox()
    const moverBefore = w.dirs.users.find((u) => u.externalId === "g_mover")!
    expect(w.members.has(moverBefore.clerkUserId!)).toBe(true)

    phase = "moved"
    const res = await w.pull()
    expect(res).toEqual({
      outcome: "ok",
      users: { created: 1, updated: 1, deleted: 0, unchanged: 1 },
      groups: { created: 0, updated: 0, deleted: 0, unchanged: 0 },
    })
    await w.drainOutbox()

    // User only on unproved domains (even with an arbitrary `emails` entry) is dropped.
    expect(w.dirs.users.find((u) => u.externalId === "g_unproved")).toBeUndefined()

    // Kept user whose primary moved to unproved `gw2.i10.tech` stays on `mover@i10.tech` and keeps their i10 account.
    const moverAfter = w.dirs.users.find((u) => u.externalId === "g_mover")!
    expect(moverAfter.id).toBe(moverBefore.id)
    expect(moverAfter.deletedAt).toBeNull()
    expect(moverAfter.userName).toBe("mover@i10.tech")
    expect(moverAfter.email).toBe("mover@i10.tech")
    expect(moverAfter.clerkUserId).toBe(moverBefore.clerkUserId)
    expect(moverAfter.conflict).toBeNull()
    expect(w.members.has(moverBefore.clerkUserId!)).toBe(true)

    // User matched via `nonEditableAliases` on a proved domain is also kept under that alias.
    const nonEditRow = w.dirs.users.find((u) => u.externalId === "g_nonedit")!
    expect(nonEditRow.userName).toBe("legacy@i10.tech")
    expect(nonEditRow.email).toBe("legacy@i10.tech")
    expect(nonEditRow.conflict).toBeNull()
    expect(w.members.has(nonEditRow.clerkUserId!)).toBe(true)
  })

  it("keeps groups whose email or alias is on a proved domain and drops unproved-domain groups without fetching their members", async () => {
    let moveGroupOut = false
    const memberRequests: string[] = []
    const w = syncWorld({
      domains: ["i10.tech"],
      adminEmail: "admin@i10.tech",
      domain: "i10.tech",
      googleHandler: (call) => {
        if (call.url.href === GOOGLE_TOKEN_URL)
          return jsonResponse({ access_token: "tok_grp", expires_in: 3600 })
        if (call.url.pathname.endsWith("/users")) {
          return jsonResponse({
            users: [
              {
                id: "g_ada",
                primaryEmail: "ada@i10.tech",
                name: { givenName: "Ada", familyName: "Lovelace" },
              },
            ],
          })
        }
        if (call.url.pathname.endsWith("/groups")) {
          return jsonResponse({
            groups: [
              { id: "grp_proved", email: "eng@i10.tech", name: "Engineering" },
              {
                id: "grp_alias",
                email: "team@gw2.i10.tech",
                aliases: ["team@i10.tech"],
                name: "Alias Team",
              },
              moveGroupOut
                ? { id: "grp_moving", email: "ops@outsider.test", name: "Ops" }
                : { id: "grp_moving", email: "ops@i10.tech", name: "Ops" },
              {
                id: "grp_unproved",
                email: "secret@outsider.test",
                aliases: ["secret@gw2.i10.tech"],
                name: "Unproved Group",
              },
            ],
          })
        }
        memberRequests.push(call.url.pathname)
        return jsonResponse({
          members: [{ id: "g_ada", type: "USER", status: "ACTIVE" }],
        })
      },
    })

    expect(await w.pull()).toEqual({
      outcome: "ok",
      users: { created: 1, updated: 0, deleted: 0, unchanged: 0 },
      groups: { created: 3, updated: 0, deleted: 0, unchanged: 0 },
    })
    expect(memberRequests.some((pathname) => pathname.includes("grp_unproved"))).toBe(
      false,
    )
    expect(w.dirs.groups.map((g) => g.externalId).sort()).toEqual([
      "grp_alias",
      "grp_moving",
      "grp_proved",
    ])

    moveGroupOut = true
    expect(await w.pull()).toEqual({
      outcome: "ok",
      users: { created: 0, updated: 0, deleted: 0, unchanged: 1 },
      groups: { created: 0, updated: 0, deleted: 1, unchanged: 2 },
    })
    expect(w.dirs.groups.map((g) => g.externalId).sort()).toEqual([
      "grp_alias",
      "grp_proved",
    ])
  })

  it("enforces the shrink guard above 20% and 5 people with counts in the audit log, allows drops at or below either bound, and preserves empty_directory", async () => {
    expect(GOOGLE_MAX_DROP_PERCENT).toBe(20)
    expect(GOOGLE_MAX_DROP_USERS).toBe(5)

    let activeCount = 10
    const makeUsers = (count: number) =>
      Array.from({ length: count }, (_, idx) => ({
        id: `g_u${idx + 1}`,
        primaryEmail: `u${idx + 1}@acme.test`,
        name: { givenName: "User", familyName: `${idx + 1}` },
      }))

    const w = syncWorld({
      googleHandler: (call) => {
        if (call.url.href === GOOGLE_TOKEN_URL)
          return jsonResponse({ access_token: "tok_shrink", expires_in: 3600 })
        if (call.url.pathname.endsWith("/users"))
          return jsonResponse({ users: makeUsers(activeCount) })
        return jsonResponse({})
      },
    })

    // Seed 10 live users.
    expect((await w.pull()).outcome).toBe("ok")
    expect(w.dirs.users.filter((u) => u.deletedAt === null)).toHaveLength(10)

    // Removing 5 of 10 (50%, but not > 5 people) is allowed.
    activeCount = 5
    expect(await w.pull()).toEqual({
      outcome: "ok",
      users: { created: 0, updated: 0, deleted: 5, unchanged: 5 },
      groups: { created: 0, updated: 0, deleted: 0, unchanged: 0 },
    })

    // Grow to 30 live users, then remove 6 of 30 (6 > 5, but 20% is not > 20%) -> allowed.
    activeCount = 30
    expect((await w.pull()).outcome).toBe("ok")
    expect(w.dirs.users.filter((u) => u.deletedAt === null)).toHaveLength(30)

    activeCount = 24
    expect(await w.pull()).toEqual({
      outcome: "ok",
      users: { created: 0, updated: 0, deleted: 6, unchanged: 24 },
      groups: { created: 0, updated: 0, deleted: 0, unchanged: 0 },
    })

    // Grow back to 30 live users, then try to remove 7 of 30 (7 > 5 and 23.3% > 20%) -> `large_drop`.
    activeCount = 30
    expect((await w.pull()).outcome).toBe("ok")
    expect(w.dirs.users.filter((u) => u.deletedAt === null)).toHaveLength(30)
    const outboxBefore30 = w.dirs.outbox.length

    activeCount = 23
    expect(await w.pull()).toEqual({
      outcome: "failed",
      error: "large_drop",
      retryable: false,
    })
    expect(w.dirs.users.filter((u) => u.deletedAt === null)).toHaveLength(30)
    expect(w.dirs.outbox).toHaveLength(outboxBefore30)
    expect(w.identity.events.at(-1)).toMatchObject({
      type: "directory.sync_failed",
      reason: "large_drop",
      data: {
        directoryId: DIRECTORY,
        existingUsers: 30,
        removedUsers: 7,
        keptUsers: 23,
      },
    })

    // Remove 1 user cleanly to reach 29 live users, then try to remove 6 of 29 (6 > 5 and 20.69% > 20%) -> `large_drop`.
    activeCount = 29
    expect(await w.pull()).toEqual({
      outcome: "ok",
      users: { created: 0, updated: 0, deleted: 1, unchanged: 29 },
      groups: { created: 0, updated: 0, deleted: 0, unchanged: 0 },
    })
    const outboxBefore29 = w.dirs.outbox.length

    activeCount = 23
    expect(await w.pull()).toEqual({
      outcome: "failed",
      error: "large_drop",
      retryable: false,
    })
    expect(w.dirs.users.filter((u) => u.deletedAt === null)).toHaveLength(29)
    expect(w.dirs.outbox).toHaveLength(outboxBefore29)
    expect(w.identity.events.at(-1)).toMatchObject({
      type: "directory.sync_failed",
      reason: "large_drop",
      data: {
        directoryId: DIRECTORY,
        existingUsers: 29,
        removedUsers: 6,
        keptUsers: 23,
      },
    })

    // Returning 0 users still trips `empty_directory` before `large_drop`.
    activeCount = 0
    expect(await w.pull()).toEqual({
      outcome: "failed",
      error: "empty_directory",
      retryable: false,
    })
    expect(w.dirs.users.filter((u) => u.deletedAt === null)).toHaveLength(29)
  })

  describe("an owner's go-ahead past the shrink guard", () => {
    const seededWorld = async (live: { count: number }) => {
      const w = syncWorld({
        googleHandler: (call) => {
          if (call.url.href === GOOGLE_TOKEN_URL)
            return jsonResponse({ access_token: "tok_drop", expires_in: 3600 })
          if (call.url.pathname.endsWith("/users"))
            return jsonResponse({
              users: Array.from({ length: live.count }, (_, idx) => ({
                id: `g_u${idx + 1}`,
                primaryEmail: `u${idx + 1}@acme.test`,
                name: { givenName: "User", familyName: `${idx + 1}` },
              })),
            })
          return jsonResponse({})
        },
      })
      live.count = 30
      expect((await w.pull()).outcome).toBe("ok")
      live.count = 23
      expect((await w.pull()).outcome).toBe("failed")
      return w
    }
    const liveCount = (w: Awaited<ReturnType<typeof seededWorld>>) =>
      w.dirs.users.filter((u) => u.deletedAt === null).length
    const dropEvents = (w: Awaited<ReturnType<typeof seededWorld>>) =>
      w.identity.events.filter((e) => e.reason === "large_drop")

    it("applies exactly the confirmed removal on the next pull and clears the allowance", async () => {
      const live = { count: 30 }
      const w = await seededWorld(live)
      expect(liveCount(w)).toBe(30)
      expect(
        await w.dirs.store.allowDirectoryDrop(TENANT, DIRECTORY, {
          users: 7,
          at: new Date("2026-10-24T12:00:00Z"),
        }),
      ).toBe(true)

      expect(await w.pull()).toEqual({
        outcome: "ok",
        users: { created: 0, updated: 0, deleted: 7, unchanged: 23 },
        groups: { created: 0, updated: 0, deleted: 0, unchanged: 0 },
      })
      expect(liveCount(w)).toBe(23)
      const dir = w.dirs.directories.get(DIRECTORY)!
      expect(dir).toMatchObject({
        lastSyncStatus: "ok",
        lastSyncError: null,
        allowDropUpTo: null,
        allowDropAt: null,
      })
    })

    it("refuses again, with the new counts, when more people would go than were confirmed", async () => {
      const live = { count: 30 }
      const w = await seededWorld(live)
      await w.dirs.store.allowDirectoryDrop(TENANT, DIRECTORY, {
        users: 7,
        at: new Date("2026-10-24T12:00:00Z"),
      })

      live.count = 22
      expect(await w.pull()).toEqual({
        outcome: "failed",
        error: "large_drop",
        retryable: false,
      })
      expect(liveCount(w)).toBe(30)
      // The same error code as before, yet the owner is told the new number.
      expect(dropEvents(w).at(-1)).toMatchObject({
        data: { existingUsers: 30, removedUsers: 8, keptUsers: 22 },
      })
      expect(dropEvents(w)).toHaveLength(2)
      // The go-ahead is spent: the same pull again is refused with no new say-so.
      expect(w.dirs.directories.get(DIRECTORY)).toMatchObject({
        allowDropUpTo: null,
        allowDropAt: null,
      })
    })

    it("ignores an allowance older than 24 hours", async () => {
      const live = { count: 30 }
      const w = await seededWorld(live)
      await w.dirs.store.allowDirectoryDrop(TENANT, DIRECTORY, {
        users: 7,
        at: new Date("2026-10-23T12:00:00Z"),
      })

      expect(await w.pull()).toEqual({
        outcome: "failed",
        error: "large_drop",
        retryable: false,
      })
      expect(liveCount(w)).toBe(30)
    })

    it("is only stored for a Google directory whose last sync failed large_drop", async () => {
      const live = { count: 30 }
      const w = await seededWorld(live)
      const dir = w.dirs.directories.get(DIRECTORY)!
      dir.lastSyncError = "unreachable"
      expect(
        await w.dirs.store.allowDirectoryDrop(TENANT, DIRECTORY, {
          users: 7,
          at: new Date("2026-10-24T12:00:00Z"),
        }),
      ).toBe(false)
      expect(dir.allowDropUpTo).toBeNull()
    })
  })
})

// ── 5. Schedule & `users.watch` channel lifecycle ───────────────────────────

describe("schedule and watch channel lifecycle", () => {
  const sa = parseGoogleServiceAccount(SERVICE_ACCOUNT_JSON)

  it("refuses watch registration over plain http or on disabled directories, and throws only on retryable worker failures", async () => {
    const dirs = memoryDirectories({
      domains: ["acme.test"],
      directories: [
        {
          id: DIRECTORY,
          provider: "google",
          enabled: true,
          adminEmail: "admin@acme.test",
          domain: "acme.test",
        },
      ],
    })
    const identity = memoryStore()
    const net = fakeGoogleFetch(() =>
      jsonResponse({ error: "unauthorized_client" }, 401),
    )
    const tokens = createGoogleTokenSource({ serviceAccount: sa, fetch: net.fetch })

    expect(
      await ensureGoogleWatchChannels(
        {
          store: dirs.store,
          tokens,
          fetch: net.fetch,
          notifyUrl: "http://api.test/google/directory/notify",
          log,
        },
        dirs.directories.get(DIRECTORY)!,
      ),
    ).toBe(0)
    expect(net.calls).toHaveLength(0)

    // Permanent failure (`delegation_missing`) resolves without throwing so groupmq does not spin.
    const permanent = await runGoogleDirectoryJob(
      {
        store: dirs.store,
        tokens,
        fetch: net.fetch,
        notifyUrl: "https://api.test/google/directory/notify",
        schedule: async () => {},
        record: (t, e) => identity.store.record(t, e),
        log,
      },
      { tenantId: TENANT, directoryId: DIRECTORY, cause: "scheduled" },
    )
    expect(permanent).toEqual({
      outcome: "failed",
      error: "delegation_missing",
      retryable: false,
    })

    // Transient failure (`rate_limited`) throws so groupmq backs off and retries.
    const rateNet = fakeGoogleFetch(() => jsonResponse({ error: "slow_down" }, 429))
    const rateTokens = createGoogleTokenSource({
      serviceAccount: sa,
      fetch: rateNet.fetch,
    })
    await expect(
      runGoogleDirectoryJob(
        {
          store: dirs.store,
          tokens: rateTokens,
          fetch: rateNet.fetch,
          notifyUrl: "https://api.test/google/directory/notify",
          schedule: async () => {},
          record: (t, e) => identity.store.record(t, e),
          log,
        },
        { tenantId: TENANT, directoryId: DIRECTORY, cause: "scheduled" },
      ),
    ).rejects.toThrow(/rate_limited/)
  })

  it("deduplicates 15-minute scheduled pulls per directory group, registers hashed watch channels, renews expiring ones, and stops them", async () => {
    const added: {
      groupId: string
      jobId?: string
      delay?: number
      data: GooglePullJob
    }[] = []
    const enqueue = googlePullScheduler({
      add: (async (opts: {
        groupId: string
        jobId?: string
        delay?: number
        data: GooglePullJob
      }) => {
        if (!added.some((j) => j.jobId === opts.jobId)) added.push(opts)
        return {} as never
      }) as never,
    })

    const t0 = Date.parse("2026-10-24T12:00:00Z")
    await enqueue({ tenantId: TENANT, directoryId: DIRECTORY, cause: "scheduled" }, t0)
    await enqueue(
      { tenantId: TENANT, directoryId: DIRECTORY, cause: "scheduled" },
      t0 + 60_000,
    )
    expect(added).toHaveLength(1)
    expect(added[0]!.groupId).toBe(`google-dir:${DIRECTORY}`)
    expect(added[0]!.delay).toBeUndefined()

    await enqueue(
      { tenantId: TENANT, directoryId: DIRECTORY, cause: "scheduled" },
      t0 + GOOGLE_PULL_INTERVAL_MS,
    )
    expect(added).toHaveLength(2)
    expect(googlePullJobId(DIRECTORY, "enable", t0)).not.toBe(
      googlePullJobId(DIRECTORY, "scheduled", t0),
    )

    // Scheduler pages only enabled Google directories.
    const dirs = memoryDirectories({
      domains: ["acme.test"],
      directories: [
        {
          id: DIRECTORY,
          provider: "google",
          enabled: true,
          adminEmail: "admin@acme.test",
          domain: "acme.test",
        },
        {
          id: OTHER_DIRECTORY,
          provider: "google",
          enabled: false,
          adminEmail: "admin@acme.test",
          domain: "acme.test",
        },
        {
          id: "66666666-6666-4666-8666-666666666666",
          provider: "okta",
          enabled: true,
        },
      ],
    })
    const dueJobs: GooglePullJob[] = []
    const count = await enqueueDueGoogleDirectories({
      store: dirs.store,
      enqueue: async (job) => {
        dueJobs.push(job)
      },
      log,
      now: () => t0,
    })
    expect(count).toBe(1)
    expect(dueJobs).toEqual([
      { tenantId: TENANT, directoryId: DIRECTORY, cause: "scheduled" },
    ])

    const scheduler = startGoogleDirectoryScheduler({
      store: dirs.store,
      enqueue: async () => {},
      log,
      intervalMs: 60_000,
    })
    scheduler.stop()

    // Watch channel registration, secret hashing, renewal, and stop.
    let nowMs = t0
    const sentTokens = new Map<string, string>()
    const stoppedRemote: string[] = []
    let watchSeq = 0

    const net = fakeGoogleFetch((call) => {
      if (call.url.href === GOOGLE_TOKEN_URL)
        return jsonResponse({ access_token: "tok_watch", expires_in: 3600 })
      if (call.url.href.startsWith(`${GOOGLE_DIRECTORY_API_BASE}/users/watch`)) {
        const body = JSON.parse(call.body) as {
          id: string
          token: string
          address: string
        }
        expect(body.address).toBe("https://api.test/google/directory/notify")
        sentTokens.set(body.id, body.token)
        return jsonResponse({
          id: body.id,
          resourceId: `res_${++watchSeq}`,
          expiration: String(nowMs + GOOGLE_WATCH_TTL_MS),
        })
      }
      if (call.url.href === `${GOOGLE_DIRECTORY_API_BASE}/channels/stop`) {
        const body = JSON.parse(call.body) as { id: string; resourceId: string }
        stoppedRemote.push(body.id)
        return new Response("", { status: 204 })
      }
      return jsonResponse({}, 404)
    })
    const tokens = createGoogleTokenSource({
      serviceAccount: sa,
      fetch: net.fetch,
      now: () => new Date(nowMs),
    })
    const dir = dirs.directories.get(DIRECTORY)!

    const registered = await ensureGoogleWatchChannels(
      {
        store: dirs.store,
        tokens,
        fetch: net.fetch,
        notifyUrl: "https://api.test/google/directory/notify",
        log,
        now: () => new Date(nowMs),
      },
      dir,
    )
    expect(registered).toBe(GOOGLE_WATCH_EVENTS.length)
    expect(dirs.watchChannels).toHaveLength(4)

    // Only SHA-256 hashes are stored; raw secrets never touch the store.
    for (const row of dirs.watchChannels) {
      const rawSecret = sentTokens.get(row.id)!
      expect(rawSecret.length).toBeGreaterThan(20)
      expect(row.tokenHash).toBe(hashSecret(rawSecret))
      expect(JSON.stringify(dirs.watchChannels)).not.toContain(rawSecret)
    }

    // Well before renewal threshold: 0 new channels registered.
    nowMs += 60_000
    expect(
      await ensureGoogleWatchChannels(
        {
          store: dirs.store,
          tokens,
          fetch: net.fetch,
          notifyUrl: "https://api.test/google/directory/notify",
          log,
          now: () => new Date(nowMs),
        },
        dir,
      ),
    ).toBe(0)

    // Inside the 45-minute renewal window: renews all 4 and stops the old channels.
    const oldIds = dirs.watchChannels.map((c) => c.id)
    nowMs = t0 + GOOGLE_WATCH_TTL_MS - GOOGLE_WATCH_RENEW_BEFORE_MS + 1_000
    expect(
      await ensureGoogleWatchChannels(
        {
          store: dirs.store,
          tokens,
          fetch: net.fetch,
          notifyUrl: "https://api.test/google/directory/notify",
          log,
          now: () => new Date(nowMs),
        },
        dir,
      ),
    ).toBe(4)
    expect(stoppedRemote.sort()).toEqual(oldIds.sort())
    expect(dirs.watchChannels).toHaveLength(4)

    // Disabling stops every remaining channel and deletes the rows.
    const currentIds = dirs.watchChannels.map((c) => c.id)
    stoppedRemote.length = 0
    const stoppedCount = await stopGoogleWatchChannels(
      {
        store: dirs.store,
        tokens,
        fetch: net.fetch,
        log,
        now: () => new Date(nowMs),
      },
      { tenantId: TENANT, directoryId: DIRECTORY, adminEmail: "admin@acme.test" },
    )
    expect(stoppedCount).toBe(4)
    expect(dirs.watchChannels).toHaveLength(0)
    expect(stoppedRemote.sort()).toEqual(currentIds.sort())
  })
})

// ── 6. Push notifications (`POST /google/directory/notify`) ─────────────────

describe("POST /google/directory/notify: refusals first, then pull scheduling", () => {
  const CHANNEL_ID = "77777777-7777-4777-8777-777777777777"
  const EXPIRED_CHANNEL_ID = "88888888-8888-4888-8888-888888888888"
  const SECRET = "google_watch_secret_token_343"
  const NOW = new Date("2026-10-24T12:00:00Z")

  function notifyWorld(
    opts: {
      enabled?: boolean
      limits?: { perIp?: number; authFailures?: number; perDirectory?: number }
    } = {},
  ) {
    const dirs = memoryDirectories({
      directories: [
        {
          id: DIRECTORY,
          provider: "google",
          enabled: opts.enabled ?? true,
          adminEmail: "admin@acme.test",
          domain: "acme.test",
        },
      ],
    })
    dirs.watchChannels.push(
      {
        id: CHANNEL_ID,
        tenantId: TENANT,
        directoryId: DIRECTORY,
        event: "update",
        resourceId: "res_live",
        tokenHash: hashSecret(SECRET),
        expiresAt: new Date(NOW.getTime() + 3600_000),
        createdAt: NOW,
      },
      {
        id: EXPIRED_CHANNEL_ID,
        tenantId: TENANT,
        directoryId: DIRECTORY,
        event: "delete",
        resourceId: "res_old",
        tokenHash: hashSecret(SECRET),
        expiresAt: new Date(NOW.getTime() - 1_000),
        createdAt: NOW,
      },
    )
    const identity = memoryStore()
    const pulls: { tenantId: string; directoryId: string }[] = []
    const app = createApp({
      googleDirectory: {
        store: dirs.store,
        schedulePull: async (tenantId, directoryId) => {
          pulls.push({ tenantId, directoryId })
        },
        record: (tenantId, event) => identity.store.record(tenantId, event),
        take: fixedWindow(null, () => NOW.getTime()),
        contextSecret: undefined,
        edgeSecret: EDGE_SECRET,
        limits: {
          ...(opts.limits?.perIp
            ? { perIp: { max: opts.limits.perIp, windowSeconds: 60 } }
            : {}),
          ...(opts.limits?.authFailures
            ? { authFailures: { max: opts.limits.authFailures, windowSeconds: 60 } }
            : {}),
          ...(opts.limits?.perDirectory
            ? { perDirectory: { max: opts.limits.perDirectory, windowSeconds: 60 } }
            : {}),
        },
        log,
        now: () => NOW,
      },
    })
    return { app, dirs, identity, pulls }
  }

  it("refuses unwired routes, oversized bodies, malformed ids, unknown channels, wrong tokens (audited without secrets), expired channels, disabled directories, and rate-limit floods", async () => {
    // 501 when not wired.
    const unwired = createApp()
    expect(
      (await unwired.request("/google/directory/notify", { method: "POST" })).status,
    ).toBe(501)

    const w = notifyWorld()

    // 413 on oversized body.
    expect(
      (
        await w.app.request("/google/directory/notify", {
          method: "POST",
          headers: {
            "x-goog-channel-id": CHANNEL_ID,
            "x-goog-channel-token": SECRET,
          },
          body: "x".repeat(70 * 1024),
        })
      ).status,
    ).toBe(413)

    // Missing or malformed channel id -> 401.
    for (const badId of ["", "not-a-uuid", "../etc/passwd"]) {
      const res = await w.app.request("/google/directory/notify", {
        method: "POST",
        headers: {
          "x-goog-channel-id": badId,
          "x-goog-channel-token": SECRET,
        },
      })
      expect(res.status).toBe(401)
    }

    // Unknown UUID channel -> 401.
    expect(
      (
        await w.app.request("/google/directory/notify", {
          method: "POST",
          headers: {
            "x-goog-channel-id": "99999999-9999-4999-8999-999999999999",
            "x-goog-channel-token": SECRET,
          },
        })
      ).status,
    ).toBe(401)

    // Wrong channel token -> 401 AND audited on the channel's tenant, with NO secret or hash in audit or response!
    const wrongToken = "attacker_guessed_wrong_token"
    const wrongRes = await w.app.request("/google/directory/notify", {
      method: "POST",
      headers: {
        "x-goog-channel-id": CHANNEL_ID,
        "x-goog-channel-token": wrongToken,
      },
    })
    expect(wrongRes.status).toBe(401)
    const wrongText = await wrongRes.text()
    expect(wrongText).not.toContain(wrongToken)
    expect(wrongText).not.toContain(SECRET)
    expect(wrongText).not.toContain(hashSecret(SECRET))
    expect(w.identity.events).toMatchObject([
      {
        tenantId: TENANT,
        type: "directory.notify_failed",
        reason: "invalid_token",
        data: { directoryId: DIRECTORY, channelId: CHANNEL_ID },
      },
    ])
    expect(JSON.stringify(w.identity.events)).not.toContain(wrongToken)
    expect(JSON.stringify(w.identity.events)).not.toContain(SECRET)
    expect(JSON.stringify(w.identity.events)).not.toContain(hashSecret(SECRET))

    // Expired channel -> 401 and audited as `channel_expired`.
    const expRes = await w.app.request("/google/directory/notify", {
      method: "POST",
      headers: {
        "x-goog-channel-id": EXPIRED_CHANNEL_ID,
        "x-goog-channel-token": SECRET,
      },
    })
    expect(expRes.status).toBe(401)
    expect(w.identity.events.at(-1)).toMatchObject({
      type: "directory.notify_failed",
      reason: "channel_expired",
    })

    // Disabled directory -> 403 and audited as `directory_disabled`.
    const disabledWorld = notifyWorld({ enabled: false })
    const disRes = await disabledWorld.app.request("/google/directory/notify", {
      method: "POST",
      headers: {
        "x-goog-channel-id": CHANNEL_ID,
        "x-goog-channel-token": SECRET,
      },
    })
    expect(disRes.status).toBe(403)
    expect(disabledWorld.identity.events).toMatchObject([
      {
        tenantId: TENANT,
        type: "directory.notify_failed",
        reason: "directory_disabled",
      },
    ])
    expect(disabledWorld.pulls).toEqual([])

    // Invalid resource state header -> 400.
    const badState = await w.app.request("/google/directory/notify", {
      method: "POST",
      headers: {
        "x-goog-channel-id": CHANNEL_ID,
        "x-goog-channel-token": SECRET,
        "x-goog-resource-state": "bad state!",
      },
    })
    expect(badState.status).toBe(400)

    // Rate limiting: per-IP and auth-failure caps answer 429 with Retry-After.
    const limited = notifyWorld({
      limits: { perIp: 2, authFailures: 1, perDirectory: 1 },
    })
    const bad1 = await limited.app.request("/google/directory/notify", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        ...EDGE_PROOF,
        "x-goog-channel-id": CHANNEL_ID,
        "x-goog-channel-token": "wrong",
      },
    })
    expect(bad1.status).toBe(401)
    const bad2 = await limited.app.request("/google/directory/notify", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.9",
        ...EDGE_PROOF,
        "x-goog-channel-id": CHANNEL_ID,
        "x-goog-channel-token": "wrong",
      },
    })
    expect(bad2.status).toBe(429)
    expect(Number(bad2.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(w.pulls).toEqual([])
  })

  it("ignores `sync` handshakes, ignores the notification body completely, and schedules a pull for valid change notifications", async () => {
    const w = notifyWorld({ limits: { perDirectory: 2 } })

    // `sync` handshake schedules nothing.
    const syncRes = await w.app.request("/google/directory/notify", {
      method: "POST",
      headers: {
        "x-goog-channel-id": CHANNEL_ID,
        "x-goog-channel-token": SECRET,
        "x-goog-resource-state": "sync",
      },
    })
    expect(syncRes.status).toBe(204)
    expect(w.pulls).toEqual([])

    // Untrusted body attempting to inject an account or another tenant is ignored; only `(TENANT, DIRECTORY)` is scheduled.
    const updateRes = await w.app.request("/google/directory/notify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-channel-id": CHANNEL_ID,
        "x-goog-channel-token": SECRET,
        "x-goog-resource-state": "update",
      },
      body: JSON.stringify({
        tenantId: OTHER_TENANT,
        primaryEmail: "evil-admin@acme.test",
        isAdmin: true,
      }),
    })
    expect(updateRes.status).toBe(204)
    expect(w.pulls).toEqual([{ tenantId: TENANT, directoryId: DIRECTORY }])
    expect(w.dirs.users).toEqual([])

    // Per-directory rate limit caps bursts past `perDirectory`.
    const burst = await w.app.request("/google/directory/notify", {
      method: "POST",
      headers: {
        "x-goog-channel-id": CHANNEL_ID,
        "x-goog-channel-token": SECRET,
        "x-goog-resource-state": "update",
      },
    })
    expect(burst.status).toBe(429)
  })
})

describe("Part 2: Google directory retry, concurrency and watch failure (#13, #19, #22)", () => {
  describe("withGoogleRetry and parseRetryAfterMs", () => {
    it("parses retry-after header correctly", () => {
      expect(parseRetryAfterMs("5")).toBe(5000)
      expect(parseRetryAfterMs("0")).toBe(0)
      expect(parseRetryAfterMs(null)).toBeNull()
      expect(parseRetryAfterMs("invalid")).toBeNull()
    })

    it("honours retry-after on 429 / rate_limited failures", async () => {
      let attempts = 0
      const delays: number[] = []
      const fakeSleep = async (ms: number) => {
        delays.push(ms)
      }

      const res = await withGoogleRetry(
        async () => {
          attempts++
          if (attempts === 1) {
            throw new GoogleFailure("rate_limited", true, undefined, 3500)
          }
          return "ok"
        },
        { sleep: fakeSleep },
      )

      expect(res).toBe("ok")
      expect(attempts).toBe(2)
      expect(delays).toEqual([3500])
    })

    it("gives up after max attempts on continuous retryable failure", async () => {
      let attempts = 0
      const fakeSleep = async () => {}

      let caught: unknown
      await withGoogleRetry(
        async () => {
          attempts++
          throw new GoogleFailure("unreachable", true)
        },
        { maxAttempts: 3, sleep: fakeSleep },
      ).catch((err) => {
        caught = err
      })

      expect(attempts).toBe(3)
      expect(caught).toBeInstanceOf(GoogleFailure)
      expect((caught as GoogleFailure).code).toBe("unreachable")
    })

    it("does not retry on fatal non-retryable failures", async () => {
      let attempts = 0
      let caught: unknown
      await withGoogleRetry(
        async () => {
          attempts++
          throw new GoogleFailure("unauthorized_client", false)
        },
        { maxAttempts: 4 },
      ).catch((err) => {
        caught = err
      })

      expect(attempts).toBe(1)
      expect((caught as GoogleFailure).code).toBe("unauthorized_client")
    })
  })

  describe("group members concurrency", () => {
    it("bounds concurrency to GOOGLE_GROUP_MEMBERS_CONCURRENCY", async () => {
      expect(GOOGLE_GROUP_MEMBERS_CONCURRENCY).toBe(6)

      let active = 0
      let maxActive = 0
      const items = Array.from({ length: 20 }, (_, i) => i)

      const results = await mapConcurrent(
        items,
        GOOGLE_GROUP_MEMBERS_CONCURRENCY,
        async (item) => {
          active++
          if (active > maxActive) maxActive = active
          await new Promise((resolve) => setTimeout(resolve, 5))
          active--
          return item * 2
        },
      )

      expect(results).toEqual(items.map((i) => i * 2))
      expect(maxActive).toBeLessThanOrEqual(GOOGLE_GROUP_MEMBERS_CONCURRENCY)
      expect(maxActive).toBeGreaterThan(1)
    })
  })

  describe("watch failure auditing and visibility", () => {
    it("audits directory.watch_failed when channel registration throws", async () => {
      const audited: Array<{
        tenantId: string
        event: AuditEvent
      }> = []
      const fakeStore = {
        watchChannels: async () => [],
        saveWatchChannel: async () => {},
      }

      await ensureGoogleWatchChannels(
        {
          store: fakeStore as unknown as Parameters<
            typeof ensureGoogleWatchChannels
          >[0]["store"],
          tokens: {
            token: async () => "token_abc",
          } as unknown as Parameters<typeof ensureGoogleWatchChannels>[0]["tokens"],
          fetch: async () => {
            throw new Error("Google watch endpoint 503")
          },
          notifyUrl: "https://api.acme.test/google/directory/notify",
          log,
          record: async (tenantId, event) => {
            audited.push({ tenantId, event })
          },
        },
        {
          id: DIRECTORY,
          tenantId: TENANT,
          enabled: true,
          adminEmail: "admin@acme.test",
          domain: "acme.test",
        },
      )

      expect(audited.length).toBe(4)
      for (const item of audited) {
        expect(item.tenantId).toBe(TENANT)
        expect(item.event.type).toBe("directory.watch_failed")
        expect(item.event.data).toMatchObject({
          directoryId: DIRECTORY,
        })
      }
    })
  })
})
