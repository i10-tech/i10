import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseMailDeviceArgs, readLeaf } from "../scripts/mail-device.js"
import {
  acmeAuthorizeBody as acmeAuthorizeSchema,
  acmeMaxNotAfter,
  parseGoTime,
  permanentIdentifierSanDer,
  scepAuthorizeBody as scepAuthorizeSchema,
  scepMaxNotAfter,
  templateRefusal,
  type CertificateTemplate,
} from "../src/ca-hooks/body.js"
import {
  CA_HOOK_KINDS,
  parseIntermediateNotAfter,
  parseTokenHashes,
  parseWebhookIds,
  type CaHookKind,
} from "../src/ca-hooks/config.js"
import { createHookHandlers, type HookHandler } from "../src/ca-hooks/handlers.js"
import {
  createCaHooksFetch,
  HANDLER_DEADLINE_MS,
  MAX_BODY_BYTES,
  startCaHooksListener,
  WARN_WINDOW_MS,
  type HookLog,
} from "../src/ca-hooks/listener.js"
import { loadEnv } from "../src/env.js"
import {
  HookDeadlineExceeded,
  sha256,
  type HookDecision,
} from "../src/mail-devices/permits.js"
import {
  acmeBody,
  freshKey,
  goTime,
  scepAuthorizeBody,
  scepNotifyBody,
  throwawayCertificate,
} from "./support/ca-hooks.js"

/**
 * The device CA's webhook listener and its pure parts (#383 PR 3,
 * docs/research/mail-device-binding.md section 11): configuration, the
 * listener's authentication and bounds, logging, and every template rule.
 * The permit transactions are in ca-hooks-db.test.ts.
 */

const TOKEN = "relay-token-for-tests-0123456789"
const ROTATED = "relay-token-for-tests-rotated-ab"
const IDS = {
  "acme-authorize": "wh-acme-authorize",
  "scep-challenge": "wh-scep-challenge",
  "scep-authorize": "wh-scep-authorize",
  "scep-notify": "wh-scep-notify",
} as const satisfies Record<CaHookKind, string>
const NOW = new Date("2026-11-26T12:00:00Z")
const DEADLINE = new Date(NOW.getTime() + HANDLER_DEADLINE_MS)
const INTERMEDIATE_NOT_AFTER = new Date("2036-11-26T00:00:00Z")

const hex = (value: string) => sha256(value).toString("hex")

describe("CA hook configuration", () => {
  it("reads token hashes, lowercases and dedupes them, and bounds the list", () => {
    const parsed = parseTokenHashes(
      `${hex(TOKEN)}, ${hex(ROTATED).toUpperCase()},${hex(TOKEN)}`,
    )
    expect(parsed.map((b) => b.toString("hex"))).toEqual([hex(TOKEN), hex(ROTATED)])
    expect(() => parseTokenHashes("abc")).toThrow(/64 hexadecimal/)
    expect(() => parseTokenHashes(`${hex(TOKEN)},`)).toThrow(/64 hexadecimal/)
    const five = ["a", "b", "c", "d", "e"].map(hex).join(",")
    expect(() => parseTokenHashes(five)).toThrow(/at most 4/)
  })

  it("needs every webhook kind exactly once, each with its own id", () => {
    const all = CA_HOOK_KINDS.map((kind) => `${kind}=${IDS[kind]}`).join(",")
    expect(parseWebhookIds(all)).toEqual(IDS)
    expect(() => parseWebhookIds(all.split(",").slice(1).join(","))).toThrow(
      /missing acme-authorize/,
    )
    expect(() => parseWebhookIds(`${all},acme-authorize=again`)).toThrow(/twice/)
    expect(() =>
      parseWebhookIds(CA_HOOK_KINDS.map((kind) => `${kind}=same`).join(",")),
    ).toThrow(/its own id/)
    expect(() =>
      parseWebhookIds(all.replace("acme-authorize=", "acme-renew=")),
    ).toThrow(/unknown kind/)
    expect(() => parseWebhookIds(all.replace("wh-scep-notify", "wh scep"))).toThrow(
      /must match/,
    )
    expect(() => parseWebhookIds(all.replace("=wh-scep-notify", "=a=b"))).toThrow(
      /<kind>=<id>/,
    )
  })

  it("reads the intermediate's notAfter only with an explicit zone", () => {
    expect(parseIntermediateNotAfter("2036-11-26T00:00:00Z").toISOString()).toBe(
      "2036-11-26T00:00:00.000Z",
    )
    expect(parseIntermediateNotAfter("2036-11-26T02:00:00+02:00").toISOString()).toBe(
      "2036-11-26T00:00:00.000Z",
    )
    expect(() => parseIntermediateNotAfter("2036-11-26T00:00:00")).toThrow(/zone/)
    expect(() => parseIntermediateNotAfter("2036-11-26")).toThrow(/zone/)
  })
})

describe("CA hook environment", () => {
  const base: NodeJS.ProcessEnv = {
    DATABASE_URL: "postgres://i10_api:pw@localhost:5432/i10",
    REDIS_URL: "redis://localhost:6379",
    CLERK_WEBHOOK_SECRET: "whsec_test",
    CLERK_SECRET_KEY: "sk_test_abc",
    MAIL_DOMAINS: "i10.tech",
    SES_CONFIGURATION_SET: "i10-events",
  }
  const hooks = {
    CA_HOOK_TOKEN_HASHES: hex(TOKEN),
    CA_HOOK_WEBHOOK_IDS: CA_HOOK_KINDS.map((kind) => `${kind}=${IDS[kind]}`).join(","),
    CA_INTERMEDIATE_NOT_AFTER: "2036-11-26T00:00:00Z",
  }

  it("starts with none of the hook settings, on 3443 with the mounted defaults", () => {
    const env = loadEnv(base)
    expect(env.CA_HOOK_TOKEN_HASHES).toBeUndefined()
    expect(env.CA_HOOKS_PORT).toBe(3443)
    expect(env.CA_HOOKS_TLS_CERT_FILE).toBe("/etc/i10/ca-hooks/tls.crt")
  })

  it("parses all three together", () => {
    const env = loadEnv({ ...base, ...hooks })
    expect(env.CA_HOOK_TOKEN_HASHES?.[0]?.toString("hex")).toBe(hex(TOKEN))
    expect(env.CA_HOOK_WEBHOOK_IDS).toEqual(IDS)
    expect(env.CA_INTERMEDIATE_NOT_AFTER?.toISOString()).toBe(
      "2036-11-26T00:00:00.000Z",
    )
  })

  it("refuses some of them without the others, naming each missing one", () => {
    let message = ""
    try {
      loadEnv({ ...base, CA_HOOK_TOKEN_HASHES: hooks.CA_HOOK_TOKEN_HASHES })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("CA_HOOK_WEBHOOK_IDS: the CA hook settings")
    expect(message).toContain("CA_INTERMEDIATE_NOT_AFTER: the CA hook settings")
    expect(message).not.toContain("CA_HOOK_TOKEN_HASHES:")
  })

  it("refuses a malformed value without quoting it", () => {
    const secretish = "not-a-hash-but-should-never-be-printed"
    let message = ""
    try {
      loadEnv({ ...base, ...hooks, CA_HOOK_TOKEN_HASHES: secretish })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("CA_HOOK_TOKEN_HASHES")
    expect(message).not.toContain(secretish)
  })

  it("refuses the hooks on the main port", () => {
    expect(() => loadEnv({ ...base, PORT: "3443" })).toThrow(
      /CA_HOOKS_PORT: must differ/,
    )
  })
})

/** A log that records every call, to prove what is never written. */
function recordingLog() {
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] =
    []
  const log: HookLog = {
    info: (fields, message) => lines.push({ level: "info", fields, message }),
    warn: (fields, message) => lines.push({ level: "warn", fields, message }),
    error: (fields, message) => lines.push({ level: "error", fields, message }),
  }
  return { log, lines }
}

const allowAll: HookHandler = async () => ({ allow: true, outcome: "allowed" })

function listener(
  handlers: Partial<Record<CaHookKind, HookHandler>> = {},
  options: { timeoutMs?: number; now?: () => Date } = {},
) {
  const { log, lines } = recordingLog()
  const calls: { kind: CaHookKind; body: unknown; now: Date; deadline: Date }[] = []
  const wrapped = Object.fromEntries(
    CA_HOOK_KINDS.map((kind) => [
      kind,
      async (body: unknown, now: Date, deadline: Date) => {
        calls.push({ kind, body, now, deadline })
        return (handlers[kind] ?? allowAll)(body, now, deadline)
      },
    ]),
  ) as Record<CaHookKind, HookHandler>
  const fetch = createCaHooksFetch({
    tokenHashes: parseTokenHashes(`${hex(TOKEN)},${hex(ROTATED)}`),
    webhookIds: IDS,
    handlers: wrapped,
    log,
    now: options.now ?? (() => NOW),
    timeoutMs: options.timeoutMs,
  })
  return { fetch, lines, calls }
}

function hookRequest(
  path: string,
  init: {
    method?: string
    token?: string | null
    id?: string | null
    body?: string | Uint8Array<ArrayBuffer> | ReadableStream
    headers?: Record<string, string>
  } = {},
) {
  const headers = new Headers(init.headers)
  if (init.token !== null) headers.set("authorization", `Bearer ${init.token ?? TOKEN}`)
  const kind = path.slice(1) as CaHookKind
  if (init.id !== null)
    headers.set("x-smallstep-webhook-id", init.id ?? IDS[kind] ?? "none")
  return new Request(`https://hooks.test${path}`, {
    method: init.method ?? "POST",
    headers,
    body:
      init.method === "GET"
        ? undefined
        : (init.body ??
          JSON.stringify({ timestamp: goTime(NOW), marker: "body-marker" })),
  })
}

describe("the CA hooks listener", () => {
  it("serves only the four paths, by POST, with no query string", async () => {
    const { fetch, calls } = listener()
    for (const kind of CA_HOOK_KINDS) {
      const response = await fetch(hookRequest(`/${kind}`))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ allow: true })
    }
    expect(calls.map((c) => c.kind)).toEqual([...CA_HOOK_KINDS])

    for (const request of [
      hookRequest("/health"),
      hookRequest("/v1/emails"),
      hookRequest("/acme-authorize/"),
      hookRequest("/acme-authorize?x=1"),
      hookRequest("/acme-authorize", { method: "GET" }),
      hookRequest("/acme-authorize", { method: "PUT" }),
    ]) {
      const response = await fetch(request)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe("")
    }
    expect(calls).toHaveLength(CA_HOOK_KINDS.length)
  })

  it("answers 404 and calls no handler for a missing, wrong or malformed token", async () => {
    const { fetch, calls } = listener()
    for (const request of [
      hookRequest("/acme-authorize", { token: null }),
      hookRequest("/acme-authorize", { token: "wrong-token-but-long-enough" }),
      hookRequest("/acme-authorize", { token: `${TOKEN}x` }),
      hookRequest("/acme-authorize", { token: "short" }),
      hookRequest("/acme-authorize", {
        token: null,
        headers: { authorization: `Basic ${TOKEN}` },
      }),
      hookRequest("/acme-authorize", {
        token: null,
        headers: { authorization: TOKEN },
      }),
      hookRequest("/acme-authorize", { token: `${TOKEN} extra` }),
    ]) {
      const response = await fetch(request)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe("")
    }
    expect(calls).toHaveLength(0)
  })

  it("accepts every configured token, so the relay's token rotates without an outage", async () => {
    const { fetch, calls } = listener()
    expect((await fetch(hookRequest("/scep-notify", { token: TOKEN }))).status).toBe(
      200,
    )
    expect((await fetch(hookRequest("/scep-notify", { token: ROTATED }))).status).toBe(
      200,
    )
    expect(calls).toHaveLength(2)
  })

  it("answers 404 for a missing webhook id or another path's id", async () => {
    const { fetch, calls } = listener()
    for (const request of [
      hookRequest("/acme-authorize", { id: null }),
      hookRequest("/acme-authorize", { id: IDS["scep-authorize"] }),
      hookRequest("/scep-authorize", { id: IDS["acme-authorize"] }),
      hookRequest("/acme-authorize", { id: `${IDS["acme-authorize"]}x` }),
    ]) {
      expect((await fetch(request)).status).toBe(404)
    }
    expect(calls).toHaveLength(0)
  })

  it("answers 404 for a body past 64 KiB, declared or streamed", async () => {
    const { fetch, calls } = listener()
    const big = JSON.stringify({
      timestamp: goTime(NOW),
      pad: "x".repeat(MAX_BODY_BYTES),
    })
    expect((await fetch(hookRequest("/acme-authorize", { body: big }))).status).toBe(
      404,
    )

    // No Content-Length: the cap counts bytes as they arrive.
    const chunk = new Uint8Array(16 * 1024).fill(0x20)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 8) controller.enqueue(chunk)
        else controller.close()
      },
    })
    expect((await fetch(hookRequest("/acme-authorize", { body: stream }))).status).toBe(
      404,
    )

    const fits = JSON.stringify({
      timestamp: goTime(NOW),
      pad: "x".repeat(MAX_BODY_BYTES - 200),
    })
    expect((await fetch(hookRequest("/acme-authorize", { body: fits }))).status).toBe(
      200,
    )
    expect(calls).toHaveLength(1)
  })

  it("answers 404 for a body that is not JSON, or has no usable timestamp", async () => {
    const { fetch, calls } = listener()
    for (const body of [
      "not json",
      new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]),
      JSON.stringify({}),
      JSON.stringify({ timestamp: "yesterday" }),
      JSON.stringify({ timestamp: 1764158400 }),
      JSON.stringify([{ timestamp: goTime(NOW) }]),
    ]) {
      expect((await fetch(hookRequest("/scep-challenge", { body }))).status).toBe(404)
    }
    expect(calls).toHaveLength(0)
  })

  it("answers 404 for a timestamp more than 60 seconds from now, either way", async () => {
    const { fetch, calls } = listener()
    const at = (offsetMs: number) =>
      JSON.stringify({ timestamp: goTime(new Date(NOW.getTime() + offsetMs)) })
    expect(
      (await fetch(hookRequest("/scep-challenge", { body: at(-61_000) }))).status,
    ).toBe(404)
    expect(
      (await fetch(hookRequest("/scep-challenge", { body: at(61_000) }))).status,
    ).toBe(404)
    expect(
      (await fetch(hookRequest("/scep-challenge", { body: at(-59_000) }))).status,
    ).toBe(200)
    expect(
      (await fetch(hookRequest("/scep-challenge", { body: at(59_000) }))).status,
    ).toBe(200)
    expect(calls).toHaveLength(2)
  })

  it("answers step-ca's shape: allow alone, never an error a device could read", async () => {
    const { fetch } = listener({
      "acme-authorize": async () => ({ allow: false, outcome: "no_permit" }),
    })
    const response = await fetch(hookRequest("/acme-authorize"))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.text()).toBe('{"allow":false}')
  })

  it("answers a 5xx for our own faults and a handler past its bound", async () => {
    const failing = listener({
      "scep-authorize": async () => {
        throw Object.assign(new Error(`query failed with ${TOKEN} body-marker`), {
          code: "57014",
        })
      },
    })
    expect((await failing.fetch(hookRequest("/scep-authorize"))).status).toBe(500)
    expect(failing.lines.at(-1)?.fields).toEqual({
      hook: "scep-authorize",
      outcome: "error",
      sqlstate: "57014",
    })

    const slow = listener(
      { "scep-notify": () => new Promise<HookDecision>(() => {}) },
      { timeoutMs: 20 },
    )
    expect((await slow.fetch(hookRequest("/scep-notify"))).status).toBe(503)
    expect(slow.lines.at(-1)?.fields).toMatchObject({
      hook: "scep-notify",
      outcome: "timeout",
    })
  })

  it("logs the kind and the outcome, and never a header, the body or the token", async () => {
    const { fetch, lines } = listener({
      "acme-authorize": async () => ({
        allow: false,
        outcome: "key_conflict_cleared",
        permitId: "019abcde-0000-7000-8000-000000000000",
      }),
      "scep-authorize": async () => {
        throw Object.assign(new Error(`boom ${TOKEN} body-marker`), {
          query: "x",
          parameters: [TOKEN],
        })
      },
    })
    await fetch(hookRequest("/acme-authorize"))
    await fetch(hookRequest("/scep-challenge"))
    await fetch(hookRequest("/scep-authorize"))
    await fetch(hookRequest("/scep-notify", { token: "wrong-token-but-long-enough" }))
    await fetch(hookRequest("/nope"))
    const written = JSON.stringify(lines)
    for (const secret of [
      TOKEN,
      "body-marker",
      IDS["acme-authorize"],
      "Bearer",
      "authorization",
    ]) {
      expect(written).not.toContain(secret)
    }
    for (const line of lines) {
      expect(
        Object.keys(line.fields).every((k) =>
          ["hook", "outcome", "sqlstate", "permitId"].includes(k),
        ),
      ).toBe(true)
    }
    // A second key for an authorized permit is the one ERROR the handlers raise.
    expect(lines[0]).toMatchObject({
      level: "error",
      fields: { hook: "acme-authorize", outcome: "key_conflict_cleared" },
    })
    expect(lines.map((l) => l.fields.outcome)).toEqual([
      "key_conflict_cleared",
      "allowed",
      "error",
      "unauthenticated",
      "not_found",
    ])
  })

  it("gives each handler one deadline, 4 seconds after the request was read", async () => {
    const { fetch, calls } = listener()
    await fetch(hookRequest("/scep-challenge"))
    expect(calls[0]?.now).toEqual(NOW)
    expect(calls[0]?.deadline).toEqual(DEADLINE)
    expect(DEADLINE.getTime() - NOW.getTime()).toBeLessThan(5000)
  })

  it("answers a handler past its deadline as a timeout", async () => {
    const { fetch, lines } = listener({
      "acme-authorize": async () => {
        throw new HookDeadlineExceeded()
      },
    })
    expect((await fetch(hookRequest("/acme-authorize"))).status).toBe(503)
    expect(lines.at(-1)?.fields).toMatchObject({ outcome: "timeout" })
  })

  it("writes one warn line per outcome per window for a burst, then counts what it dropped", async () => {
    let clock = NOW.getTime()
    const { fetch, lines } = listener({}, { now: () => new Date(clock) })
    for (let i = 0; i < 50; i++) {
      await fetch(
        hookRequest("/acme-authorize", { token: "wrong-token-but-long-enough" }),
      )
      await fetch(hookRequest("/nope"))
    }
    expect(lines.map((l) => l.fields)).toEqual([
      { hook: "acme-authorize", outcome: "unauthenticated" },
      { hook: "unknown", outcome: "not_found" },
    ])

    clock += WARN_WINDOW_MS - 1
    await fetch(hookRequest("/nope"))
    expect(lines).toHaveLength(2)

    clock += 1
    await fetch(hookRequest("/nope"))
    expect(lines.at(-1)?.fields).toEqual({
      hook: "unknown",
      outcome: "not_found",
      suppressed: 50,
    })
    // An authenticated request is never throttled.
    await fetch(hookRequest("/scep-notify"))
    expect(lines.at(-1)).toMatchObject({
      level: "info",
      fields: { outcome: "allowed" },
    })
  })
})

describe("starting the listener", () => {
  const config = {
    port: 0,
    certFile: "/nonexistent/tls.crt",
    keyFile: "/nonexistent/tls.key",
    tokenHashes: parseTokenHashes(hex(TOKEN)),
    webhookIds: IDS,
    intermediateNotAfter: INTERMEDIATE_NOT_AFTER,
  }
  const noHandlers = () => {
    throw new Error("handlers must not be built when the listener is off")
  }

  it("stays off, and says so once, when not configured", () => {
    const { log, lines } = recordingLog()
    expect(
      startCaHooksListener({ ...config, tokenHashes: undefined }, noHandlers, log),
    ).toBeNull()
    expect(lines).toEqual([
      {
        level: "info",
        fields: { hooks: "off", reason: "not_configured" },
        message: "ca hooks listener off",
      },
    ])
  })

  it("stays off until both TLS files are mounted", () => {
    const { log, lines } = recordingLog()
    expect(startCaHooksListener(config, noHandlers, log)).toBeNull()
    expect(lines[0]?.fields).toEqual({ hooks: "off", reason: "no_certificate" })
  })

  describe("with a certificate mounted", () => {
    let dir: string
    let tls: ReturnType<typeof throwawayCertificate>
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "i10-ca-hooks-listener-"))
      tls = throwawayCertificate()
      writeFileSync(join(dir, "tls.crt"), tls.certPem)
      writeFileSync(join(dir, "tls.key"), tls.keyPem)
    })
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    it("stays off, and leaves the API running, when the certificate cannot be used", () => {
      writeFileSync(join(dir, "broken.crt"), "not a certificate")
      const { log, lines } = recordingLog()
      const started = startCaHooksListener(
        { ...config, certFile: join(dir, "broken.crt"), keyFile: join(dir, "tls.key") },
        () => ({}) as Record<CaHookKind, HookHandler>,
        log,
      )
      expect(started).toBeNull()
      expect(lines.at(-1)).toMatchObject({
        level: "error",
        fields: { hooks: "off", reason: "start_failed" },
      })
      expect(JSON.stringify(lines)).not.toContain("PRIVATE KEY")
    })

    it("serves the hooks over TLS on its own port, and no main route", async () => {
      const { log } = recordingLog()
      const seen: CaHookKind[] = []
      const handlers = Object.fromEntries(
        CA_HOOK_KINDS.map((kind): [CaHookKind, HookHandler] => [
          kind,
          async () => {
            seen.push(kind)
            return { allow: true, outcome: "allowed" }
          },
        ]),
      ) as Record<CaHookKind, HookHandler>
      const started = startCaHooksListener(
        { ...config, certFile: join(dir, "tls.crt"), keyFile: join(dir, "tls.key") },
        () => handlers,
        log,
      )
      expect(started).not.toBeNull()
      try {
        const post = (path: string) =>
          fetch(`https://127.0.0.1:${started!.port}${path}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "x-smallstep-webhook-id": IDS["scep-notify"],
            },
            body: JSON.stringify({ timestamp: goTime(new Date()) }),
            tls: { rejectUnauthorized: false },
          })
        const ok = await post("/scep-notify")
        expect(ok.status).toBe(200)
        expect(await ok.json()).toEqual({ allow: true })
        expect((await post("/health")).status).toBe(404)
        expect((await post("/v1/emails")).status).toBe(404)

        // ⚠ THE ONE ANSWER THAT IS NOT A 404: Bun's `maxRequestBodySize` sends
        // a bare 413 itself, declared length or streamed, without a token.
        const oversize = await fetch(`https://127.0.0.1:${started!.port}/scep-notify`, {
          method: "POST",
          body: "x".repeat(MAX_BODY_BYTES + 1),
          tls: { rejectUnauthorized: false },
        })
        expect(oversize.status).toBe(413)
        expect(await oversize.text()).toBe("")
        const chunk = new Uint8Array(16 * 1024).fill(0x20)
        let sent = 0
        const streamed = await fetch(`https://127.0.0.1:${started!.port}/scep-notify`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "x-smallstep-webhook-id": IDS["scep-notify"],
          },
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent++ < 8) controller.enqueue(chunk)
              else controller.close()
            },
          }),
          tls: { rejectUnauthorized: false },
        })
        expect(streamed.status).toBe(413)
        expect(await streamed.text()).toBe("")
        expect(seen).toEqual(["scep-notify"])
      } finally {
        await started!.stop()
      }
    })
  })
})

describe("reading step-ca's times", () => {
  it("reads Go's RFC 3339 with nanoseconds and with an offset", () => {
    expect(parseGoTime("2026-11-26T12:00:00.123456789Z")?.toISOString()).toBe(
      "2026-11-26T12:00:00.123Z",
    )
    expect(parseGoTime("2026-11-26T14:00:00+02:00")?.toISOString()).toBe(
      "2026-11-26T12:00:00.000Z",
    )
    expect(parseGoTime("2026-11-26T12:00:00")).toBeNull()
    expect(parseGoTime("2026-13-26T12:00:00Z")).toBeNull()
  })
})

describe("the template rules", () => {
  const key = freshKey()
  const serial = "C02ZK1ABCDEF"
  const nonce = "nonce-0123456789abcdefgh"
  const acmeRules = {
    serial,
    keyUsage: ["digitalSignature"],
    extKeyUsage: ["clientAuth"],
    permanentIdentifierSan: true,
    maxNotAfter: acmeMaxNotAfter(NOW),
    intermediateNotAfter: INTERMEDIATE_NOT_AFTER,
    now: NOW,
  }
  const scepRules = {
    ...acmeRules,
    keyUsage: ["digitalSignature", "keyEncipherment"],
    extKeyUsage: ["emailProtection"],
    permanentIdentifierSan: false,
    maxNotAfter: scepMaxNotAfter(NOW),
  }
  const handlers = createHookHandlers({
    db: {
      transaction: () => {
        throw new Error("a template refusal must never reach the database")
      },
    } as never,
    intermediateNotAfter: INTERMEDIATE_NOT_AFTER,
  })

  /** Parses a body through the real ACME handler, which refuses before the database. */
  async function acme(
    certificate: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ) {
    return handlers["acme-authorize"](
      {
        ...acmeBody({ serial, nonce, spki: key.spki, now: NOW, certificate }),
        ...overrides,
      },
      NOW,
      DEADLINE,
    )
  }
  async function scep(certificate: Record<string, unknown> = {}) {
    return handlers["scep-authorize"](
      scepAuthorizeBody({ commonName: serial, spki: key.spki, now: NOW, certificate }),
      NOW,
      DEADLINE,
    )
  }

  const sanExtension = (of: string) => ({
    id: "2.5.29.17",
    critical: false,
    value: permanentIdentifierSanDer(of).toString("base64"),
  })
  const iso = (offsetMs: number, from = NOW) =>
    goTime(new Date(from.getTime() + offsetMs))
  const minute = 60 * 1000
  const day = 24 * 60 * minute

  it("encodes the permanent identifier SAN byte for byte as x509util v0.77.1 does", () => {
    // `x509util.NewCertificate` with the apple template, serial C02ZK1ABCDEF.
    expect(permanentIdentifierSanDer("C02ZK1ABCDEF").toString("base64")).toBe(
      "MB6gHAYIKwYBBQUHCAOgEDAODAxDMDJaSzFBQkNERUY=",
    )
  })

  it("passes the apple and apple-scep templates as step-ca renders them", () => {
    const acmeParsed = acmeAuthorizeSchema.safeParse(
      acmeBody({ serial, nonce, spki: key.spki, now: NOW }),
    )
    expect(acmeParsed.success).toBe(true)
    expect(templateRefusal(acmeParsed.data!.x509Certificate, acmeRules)).toBeNull()

    const scepParsed = scepAuthorizeSchema.safeParse(
      scepAuthorizeBody({ commonName: serial, spki: key.spki, now: NOW }),
    )
    expect(scepParsed.success).toBe(true)
    expect(templateRefusal(scepParsed.data!.x509Certificate, scepRules)).toBeNull()
  })

  it.each([
    [
      "a CN other than the serial",
      { subject: { commonName: "OTHER", organizationalUnit: [nonce] } },
    ],
    ["no CN", { subject: { organizationalUnit: [nonce] } }],
    ["a rawSubject that would replace the subject", { rawSubject: "MAA=" }],
    ["a DNS name", { dnsNames: ["mail.example.com"] }],
    ["an email address", { emailAddresses: ["a@example.com"] }],
    ["an IP address", { ipAddresses: ["127.0.0.1"] }],
    ["a URI", { uris: ["https://example.com"] }],
    ["a DNS SAN", { sans: [{ type: "dns", value: "mail.example.com" }] }],
    ["an auto SAN", { sans: [{ type: "auto", value: "mail.example.com" }] }],
    [
      "another serial's permanent identifier",
      { sans: [{ type: "permanentIdentifier", value: "OTHER" }] },
    ],
    [
      "a subjectAltName extension that is not the serial's",
      { extensions: [{ id: "2.5.29.17", critical: false, value: "MAA=" }] },
    ],
    [
      "another serial's subjectAltName extension",
      { extensions: [sanExtension("OTHER")] },
    ],
    [
      "the serial's subjectAltName extension marked critical",
      { extensions: [{ ...sanExtension(serial), critical: true }] },
    ],
    [
      "an extension beside the subjectAltName",
      {
        extensions: [
          sanExtension(serial),
          { id: "1.2.3.4", critical: false, value: "MAA=" },
        ],
      },
    ],
    [
      "a raw EKU extension",
      {
        extensions: [
          sanExtension(serial),
          { id: "2.5.29.37", critical: false, value: "MAA=" },
        ],
      },
    ],
    ["no extension for its SAN", { extensions: null }],
    [
      "the SAN twice",
      {
        sans: [
          { type: "permanentIdentifier", value: serial },
          { type: "permanentIdentifier", value: serial },
        ],
      },
    ],
    [
      "a SAN with an asn1Value, which overrides its value",
      {
        sans: [
          {
            type: "permanentIdentifier",
            value: serial,
            asn1Value: { identifier: "OTHER" },
          },
        ],
      },
    ],
    [
      "extraNames, whose 2.5.4.3 would replace the CN",
      {
        subject: {
          commonName: serial,
          organizationalUnit: [nonce],
          extraNames: [{ type: "2.5.4.3", value: "OTHER" }],
        },
      },
    ],
    [
      "another subject field",
      {
        subject: {
          commonName: serial,
          organizationalUnit: [nonce],
          organization: ["x"],
        },
      },
    ],
    [
      "keyEncipherment beside digitalSignature",
      { keyUsage: ["digitalSignature", "keyEncipherment"] },
    ],
    ["certSign", { keyUsage: ["digitalSignature", "certSign"] }],
    ["no key usage", { keyUsage: null }],
    ["an OCSP server", { ocspServer: ["http://ocsp.example.com"] }],
    ["a policy", { policyIdentifiers: ["1.2.3.4"] }],
    ["a subject key id", { subjectKeyId: "AAEC" }],
    ["a signature algorithm", { signatureAlgorithm: "SHA1-RSA" }],
    ["a field x509util does not have", { unexpected: true }],
    ["serverAuth beside clientAuth", { extKeyUsage: ["clientAuth", "serverAuth"] }],
    ["no EKU at all", { extKeyUsage: null }],
    ["emailProtection instead", { extKeyUsage: ["emailProtection"] }],
    ["an unknown EKU", { unknownExtKeyUsage: ["1.2.3.4"] }],
    ["a CA", { basicConstraints: { isCA: true, maxPathLen: 0 } }],
    ["name constraints", { nameConstraints: { critical: true } }],
    ["notBefore 6 minutes ahead", { notBefore: iso(6 * minute) }],
    ["notBefore 6 minutes behind", { notBefore: iso(-6 * minute) }],
    ["notAfter before notBefore", { notAfter: iso(-2 * minute) }],
    [
      "notAfter past 3 years and 5 minutes",
      { notAfter: goTime(new Date(acmeMaxNotAfter(NOW).getTime() + 1000)) },
    ],
    [
      "two OUs",
      { subject: { commonName: serial, organizationalUnit: [nonce, "extra"] } },
    ],
    ["no OU", { subject: { commonName: serial } }],
    [
      "a public key that is not one",
      { publicKey: Buffer.from("not a key").toString("base64") },
    ],
    ["a public key that is not base64", { publicKey: "%%%" }],
  ])("refuses ACME with %s", async (_label, certificate) => {
    const decision = await acme(certificate)
    expect(decision.allow).toBe(false)
    expect(["bad_template", "bad_body"]).toContain(decision.outcome)
  })

  it("refuses an ACME leaf that would outlive the intermediate", async () => {
    const soon = new Date(NOW.getTime() + 30 * day)
    const local = createHookHandlers({
      db: {
        transaction: () => {
          throw new Error("no db")
        },
      } as never,
      intermediateNotAfter: soon,
    })
    const decision = await local["acme-authorize"](
      acmeBody({ serial, nonce, spki: key.spki, now: NOW }),
      NOW,
      DEADLINE,
    )
    expect(decision).toEqual({ allow: false, outcome: "bad_template" })
  })

  it("refuses ACME without attestation data, or with a serial no Mac has", async () => {
    expect(await acme({}, { attestationData: undefined })).toEqual({
      allow: false,
      outcome: "bad_body",
    })
    const odd = "SERIAL WITH SPACES"
    const decision = await handlers["acme-authorize"](
      acmeBody({ serial: odd, nonce, spki: key.spki, now: NOW }),
      NOW,
      DEADLINE,
    )
    expect(decision).toEqual({ allow: false, outcome: "bad_template" })
  })

  it.each([
    ["clientAuth", { extKeyUsage: ["clientAuth"] }],
    [
      "any extension",
      { extensions: [{ id: "1.2.3.4", critical: false, value: "MAA=" }] },
    ],
    ["digitalSignature alone", { keyUsage: ["digitalSignature"] }],
    ["no key usage", { keyUsage: null }],
    ["extraNames", { subject: { commonName: serial, extraNames: [] } }],
    ["a field x509util does not have", { unexpected: true }],
    [
      "clientAuth beside emailProtection",
      { extKeyUsage: ["emailProtection", "clientAuth"] },
    ],
    ["no EKU at all, which Go's clientAuth check would pass", { extKeyUsage: [] }],
    [
      "any SAN, even a permanent identifier",
      { sans: [{ type: "permanentIdentifier", value: serial }] },
    ],
    ["a DNS name", { dnsNames: [serial] }],
    [
      "more than 7 days and 5 minutes",
      { notAfter: goTime(new Date(scepMaxNotAfter(NOW).getTime() + 1000)) },
    ],
    ["no CN", { subject: {} }],
  ])("refuses SCEP with %s", async (_label, certificate) => {
    expect(await scep(certificate)).toMatchObject({ allow: false })
  })

  it("checks the SCEP rules apart from the handler, too", () => {
    const cert = {
      subject: { commonName: serial },
      keyUsage: ["keyEncipherment", "digitalSignature"],
      extKeyUsage: ["emailProtection"],
      publicKey: key.spki,
      notBefore: new Date(NOW.getTime() - minute),
      notAfter: new Date(NOW.getTime() + 7 * day),
    } as CertificateTemplate
    expect(templateRefusal(cert, scepRules)).toBeNull()
    expect(templateRefusal({ ...cert, extKeyUsage: ["clientAuth"] }, scepRules)).toBe(
      "ext_key_usage",
    )
  })

  it("treats a NotifyFailure, a body with no certificate, as a change to nothing", async () => {
    expect(
      await handlers["scep-notify"](
        scepNotifyBody({ transactionId: "txn", der: null, now: NOW }),
        NOW,
        DEADLINE,
      ),
    ).toEqual({ allow: false, outcome: "notify_failure" })
    expect(
      await handlers["scep-notify"](
        scepNotifyBody({
          transactionId: "txn",
          der: Buffer.from("not a certificate"),
          now: NOW,
        }),
        NOW,
        DEADLINE,
      ),
    ).toEqual({ allow: false, outcome: "bad_template" })
  })

  it("refuses a SCEP challenge with no CN or no transaction id before the database", async () => {
    const body = {
      timestamp: goTime(NOW),
      scepChallenge: "challenge",
      scepTransactionID: "",
      x509CertificateRequest: {
        subject: { commonName: serial },
        publicKey: key.spki.toString("base64"),
      },
    }
    expect(await handlers["scep-challenge"](body, NOW, DEADLINE)).toEqual({
      allow: false,
      outcome: "bad_body",
    })
    const noCn = {
      ...body,
      scepTransactionID: "t",
      x509CertificateRequest: { subject: {}, publicKey: key.spki.toString("base64") },
    }
    expect(await handlers["scep-challenge"](noCn, NOW, DEADLINE)).toEqual({
      allow: false,
      outcome: "bad_template",
    })
  })
})

describe("the operator script's certificate commands", () => {
  const id = "019abcde-0123-789a-8bcd-ef0123456789"

  it("parses bind-key, unbind-key and acme-permit positionally", () => {
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
    expect(parseMailDeviceArgs(["acme-permit", id])).toEqual({
      action: "acme-permit",
      id,
    })
  })

  it("refuses a missing argument, an extra one, a flag or a non-uuid device", () => {
    expect(() => parseMailDeviceArgs(["bind-key", id])).toThrow(/<certificate.pem>/)
    expect(() => parseMailDeviceArgs(["unbind-key", id, "extra"])).toThrow(
      /<device id>/,
    )
    expect(() => parseMailDeviceArgs(["unbind-key", "--id", id])).toThrow(/<device id>/)
    expect(() => parseMailDeviceArgs(["acme-permit", "not-a-uuid"])).toThrow(
      /not a device id/,
    )
  })

  const clientAuth = ["extendedKeyUsage=clientAuth"]

  it("hashes the leaf's SubjectPublicKeyInfo and reads its CN, from the first certificate in the file", () => {
    const leaf = throwawayCertificate("/CN=C02ZK1ABCDEF/O=Probe", clientAuth)
    const other = throwawayCertificate("/CN=issuer")
    const read = readLeaf(`${leaf.certPem}${other.certPem}`)
    expect(read.keySha256.equals(leaf.spkiSha)).toBe(true)
    expect(read.commonName).toBe("C02ZK1ABCDEF")
    expect(
      readLeaf(throwawayCertificate("/O=NoName", clientAuth).certPem).commonName,
    ).toBeNull()
    expect(() => readLeaf("no certificate here")).toThrow(/no PEM certificate/)
  })

  it.each([
    ["no EKU at all", []],
    ["serverAuth only", ["extendedKeyUsage=serverAuth"]],
    ["emailProtection only", ["extendedKeyUsage=emailProtection"]],
  ])(
    "refuses a leaf with %s: the front would never sign it in",
    (_label, extensions) => {
      const leaf = throwawayCertificate("/CN=C02ZK1ABCDEF", extensions)
      expect(() => readLeaf(leaf.certPem)).toThrow(/no clientAuth/)
    },
  )

  it.each([
    ["a DNS SAN", "subjectAltName=DNS:mail.example.com"],
    ["an IP SAN", "subjectAltName=IP:192.0.2.1"],
  ])("refuses a leaf with %s, which no ACME leaf has", (_label, san) => {
    const leaf = throwawayCertificate("/CN=C02ZK1ABCDEF", [...clientAuth, san])
    expect(() => readLeaf(leaf.certPem)).toThrow(/DNS or IP/)
  })
})
