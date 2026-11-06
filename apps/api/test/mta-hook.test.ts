import { describe, expect, it, mock } from "bun:test"
import { createApp } from "../src/app.js"
import {
  decideHook,
  parseHookRequest,
  type HookDeps,
  type HookRequest,
} from "../src/mail/mta-hook.js"
import { createMtaHookRoutes, type MtaHookRouteDeps } from "../src/routes/mta-hook.js"
import { acceptSend, type AcceptOps, type AcceptOutcome } from "../src/send/accept.js"
import type { AdmitDeps, HoldScope } from "../src/send/admit.js"
import type { Metering, QuotaOutcome } from "../src/send/metering.js"

/**
 * Mailbox sends through the Stalwart MTA hook (B5, #380).
 *
 * ⚠ THE REQUEST FIXTURES ARE THE DOCS' SHAPE, NOT A CAPTURE. The wire format is
 * from https://stalw.art/docs/mta/filter/mtahooks/ and has not been probed on
 * our server, so a passing test here proves we handle what the page says and
 * nothing about what Stalwart 1.0.3 sends. The README's rollout step 5 is the
 * probe.
 */

const SECRET = "a-shared-token-for-testing"
const TENANT = "ten-1"

/** An RCPT-stage request, as the docs show one. */
const rcpt = (login: string | null, sender: string | null = "john@acme.test") => ({
  context: {
    stage: "rcpt",
    client: { ip: "192.0.2.1", port: 34567, ptr: null, helo: "mail.acme.test" },
    ...(login === null ? {} : { sasl: { login } }),
    tls: { version: "TLSv1.3", cipher: "TLS13_AES_256_GCM_SHA384" },
    server: { name: "Stalwart v1.0.3", port: 465, ip: "192.0.2.2" },
    protocol: { version: 1 },
  },
  envelope: {
    from: { address: sender ?? "" },
    to: [{ address: "bill@example.org" }, { address: "jane@example.org" }],
  },
})

const request = (over: Partial<HookRequest> = {}): HookRequest => ({
  login: "john@acme.test",
  sender: "john@acme.test",
  ...over,
})

function setup(
  over: {
    quota?: QuotaOutcome
    held?: { why: string; scope: HoldScope } | null
    owner?: string | null
  } = {},
) {
  const checkQuota = mock<Metering["checkQuota"]>(
    async () => over.quota ?? { status: "allowed" },
  )
  const recordSent = mock(async () => {})
  const metering: Metering = { checkQuota, recordSent }
  const sendingHeld = mock<NonNullable<AdmitDeps["sendingHeld"]>>(
    async () => over.held ?? null,
  )
  const domainOwner = mock<HookDeps["domainOwner"]>(async () =>
    over.owner === undefined ? TENANT : over.owner,
  )
  const deps: HookDeps = { domainOwner, admit: { sendingHeld, metering } }
  return { deps, checkQuota, recordSent, sendingHeld, domainOwner }
}

const rejected = (status: number, enhanced: string) => ({
  action: "reject" as const,
  response: {
    status,
    enhanced_status: enhanced,
    message: expect.any(String) as string,
  },
})

describe("reading Stalwart's request", () => {
  it("takes the account from sasl and the sender from the envelope", () => {
    expect(parseHookRequest(rcpt("john@acme.test"))).toEqual({
      login: "john@acme.test",
      sender: "john@acme.test",
    })
  })

  it("treats an unauthenticated session as no login", () => {
    expect(parseHookRequest(rcpt(null))?.login).toBeNull()
  })

  it("treats the null reverse path as no sender, not as an error", () => {
    expect(parseHookRequest(rcpt("john@acme.test", null))?.sender).toBeNull()
  })

  it("reads a connect-stage request, which has no envelope", () => {
    expect(parseHookRequest({ context: { stage: "connect" } })).toEqual({
      login: null,
      sender: null,
    })
  })

  it("refuses a body that is not a Stalwart request", () => {
    for (const body of [null, "x", 1, [], {}, { context: null }, { context: [] }]) {
      expect(parseHookRequest(body)).toBeNull()
    }
  })
})

describe("deciding a mailbox send", () => {
  it("accepts a workspace that is allowed to send, asking for one message", async () => {
    const { deps, checkQuota } = setup()
    expect(await decideHook(request(), deps)).toEqual({ action: "accept" })
    expect(checkQuota).toHaveBeenCalledWith(TENANT, 1)
  })

  it("finds the tenant by the sender's domain", async () => {
    const { deps, domainOwner } = setup()
    await decideHook(request({ sender: "Anyone@ACME.test" }), deps)
    expect(domainOwner).toHaveBeenCalledWith("acme.test")
  })

  it("refuses a daily allowance that is spent, as a permanent 5.4.5", async () => {
    const { deps } = setup({
      quota: { status: "exceeded", message: "You have used your sending allowance." },
    })
    expect(await decideHook(request(), deps)).toEqual(rejected(550, "5.4.5"))
  })

  it("refuses a free workspace's spent monthly line the same way, in the API's words", async () => {
    const { deps } = setup({
      quota: {
        status: "exceeded",
        code: "monthly_quota_exceeded",
        message: "This free workspace has used its monthly sending limit.",
      },
    })
    expect(await decideHook(request(), deps)).toEqual({
      action: "reject",
      response: {
        status: 550,
        enhanced_status: "5.4.5",
        message: "This free workspace has used its monthly sending limit.",
      },
    })
  })

  it("refuses a workspace held for every kind of send, as a permanent 5.7.1", async () => {
    const { deps, checkQuota } = setup({
      held: { why: "unusual activity", scope: "all" },
    })
    const answer = await decideHook(request(), deps)
    expect(answer).toEqual(rejected(550, "5.7.1"))
    // The hold is checked before the quota, as `acceptSend` does.
    expect(checkQuota).not.toHaveBeenCalled()
  })

  /**
   * ⚠ MAILBOXES ARE PEOPLE'S OWN MAIL. risk.md: "Mailboxes are not stopped by an
   * automatic hold. A hold with scope: all is staff-only." The score only writes
   * `api`, so an API hold must leave the hook accepting.
   */
  it("lets a mailbox send through a hold that only covers the API", async () => {
    const { deps } = setup({ held: { why: "unusual activity", scope: "api" } })
    expect(await decideHook(request(), deps)).toEqual({ action: "accept" })
  })

  it("sends when metering cannot answer, as the API path does", async () => {
    const { deps } = setup({
      quota: { status: "unavailable", message: "Could not check the sending quota." },
    })
    expect(await decideHook(request(), deps)).toEqual({ action: "accept" })
  })

  it("never records usage: asking is not sending", async () => {
    const { deps, recordSent } = setup()
    await decideHook(request(), deps)
    expect(recordSent).not.toHaveBeenCalled()
  })

  it("passes a sender no tenant owns, i10's own mail among them", async () => {
    const { deps, sendingHeld, checkQuota } = setup({ owner: null })
    expect(await decideHook(request({ sender: "me@i10.tech" }), deps)).toEqual({
      action: "accept",
    })
    expect(sendingHeld).not.toHaveBeenCalled()
    expect(checkQuota).not.toHaveBeenCalled()
  })

  it("does nothing for a session that has not authenticated", async () => {
    const { deps, domainOwner } = setup({ held: { why: "x", scope: "all" } })
    expect(await decideHook(request({ login: null }), deps)).toEqual({
      action: "accept",
    })
    expect(domainOwner).not.toHaveBeenCalled()
  })

  it("places a null reverse path by the login, so MAIL FROM:<> is still checked", async () => {
    const { deps } = setup({ held: { why: "x", scope: "all" } })
    expect(await decideHook(request({ sender: null }), deps)).toMatchObject({
      action: "reject",
    })
  })

  it("places by the login's domain, not a different sender domain", async () => {
    const { deps, domainOwner } = setup()
    await decideHook(request({ login: "a@login.example", sender: "b@other.example" }), deps)
    expect(domainOwner).toHaveBeenCalledWith("login.example")
  })

  it("lets a failure out rather than answering for it", async () => {
    const { deps } = setup()
    deps.admit.sendingHeld = async () => {
      throw new Error("connection terminated")
    }
    const outcome = await decideHook(request(), deps).then(
      () => "answered",
      (err: Error) => err.message,
    )
    expect(outcome).toBe("connection terminated")
  })
})

/**
 * ⚠ THE POINT OF THE FEATURE: ONE DECISION. Each case goes through `acceptSend`
 * and through the hook with the same fakes, and the two must agree - except for
 * the one deliberate difference, a hold that covers only the API.
 */
describe("the same decision as an API send", () => {
  const cases: {
    name: string
    over: Parameters<typeof setup>[0]
    api: AcceptOutcome["status"]
    hook: "accept" | "reject"
  }[] = [
    { name: "allowed", over: {}, api: "accepted", hook: "accept" },
    {
      name: "daily allowance spent",
      over: { quota: { status: "exceeded", message: "m" } },
      api: "quota_exceeded",
      hook: "reject",
    },
    {
      name: "monthly line spent",
      over: {
        quota: { status: "exceeded", message: "m", code: "monthly_quota_exceeded" },
      },
      api: "quota_exceeded",
      hook: "reject",
    },
    {
      name: "held for everything",
      over: { held: { why: "w", scope: "all" } },
      api: "held",
      hook: "reject",
    },
    {
      name: "held for the API only",
      over: { held: { why: "w", scope: "api" } },
      api: "held",
      hook: "accept",
    },
    {
      name: "metering unavailable",
      over: { quota: { status: "unavailable", message: "m" } },
      api: "accepted",
      hook: "accept",
    },
  ]

  it.each(cases)("$name", async ({ over, api, hook }) => {
    const { deps } = setup(over)
    const ops = {
      persist: async (input: { messages: unknown[] }) => ({
        status: "written" as const,
        ids: input.messages.map((_, i) => `m${i}`),
        refs: input.messages.map((_, i) => ({ id: `m${i}`, createdAt: new Date() })),
      }),
      suppressedFor: async () => new Set<string>(),
      sendableFrom: async (_t: string, domains: string[]) => new Set(domains),
      enqueue: async () => {},
      sendingHeld: deps.admit.sendingHeld,
    } as AcceptOps
    const log = { warn: mock(), error: mock() }

    const apiOutcome = await acceptSend(
      {
        tenantId: TENANT,
        apiKeyId: "key-1",
        payloads: [
          { from: "john@acme.test", to: "x@example.org", subject: "s", text: "t" },
        ],
        endpoint: "single",
      },
      { ...ops, metering: deps.admit.metering, log },
    )
    const hookOutcome = await decideHook(request(), deps)

    expect(apiOutcome.status).toBe(api)
    expect(hookOutcome.action).toBe(hook)
  })
})

describe("POST /internal/mta-hook", () => {
  const routeDeps = (over: Parameters<typeof setup>[0] = {}) => {
    const s = setup(over)
    const log = { warn: mock(), error: mock(), info: mock() }
    const deps: MtaHookRouteDeps = { ...s.deps, secret: SECRET, log }
    return { ...s, deps, log }
  }

  const call = (
    app: {
      request: (path: string, init?: RequestInit) => Response | Promise<Response>
    },
    body: unknown,
    headers: Record<string, string> = { Authorization: `Bearer ${SECRET}` },
  ) =>
    app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })

  it("answers accept for an allowed send", async () => {
    const { deps } = routeDeps()
    const res = await call(createMtaHookRoutes(deps), rcpt("john@acme.test"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ action: "accept" })
  })

  it("answers a reject Stalwart can relay, for a workspace out of allowance", async () => {
    const { deps } = routeDeps({
      quota: { status: "exceeded", message: "You have used your sending allowance." },
    })
    const res = await call(createMtaHookRoutes(deps), rcpt("john@acme.test"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      action: "reject",
      response: {
        status: 550,
        enhanced_status: "5.4.5",
        message: "You have used your sending allowance.",
      },
    })
  })

  it("answers a reject for a held workspace", async () => {
    const { deps } = routeDeps({ held: { why: "unusual activity", scope: "all" } })
    const res = await call(createMtaHookRoutes(deps), rcpt("john@acme.test"))
    expect(((await res.json()) as { action: string }).action).toBe("reject")
  })

  it.each([
    ["no Authorization header", {}],
    ["the wrong token", { Authorization: "Bearer not-the-secret" }],
    ["the right token under another scheme", { Authorization: `Basic ${SECRET}` }],
    ["an empty bearer", { Authorization: "Bearer " }],
    [
      "a longer token with the secret as its prefix",
      { Authorization: `Bearer ${SECRET}x` },
    ],
  ])("refuses %s with a 401, before reading anything", async (_name, headers) => {
    const { deps, domainOwner, log } = routeDeps()
    const res = await call(createMtaHookRoutes(deps), rcpt("john@acme.test"), headers)
    expect(res.status).toBe(401)
    expect(domainOwner).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalled()
  })

  it("answers 503 when no secret is configured, never an accept", async () => {
    const res = await call(createMtaHookRoutes(undefined), rcpt("john@acme.test"))
    expect(res.status).toBe(503)
  })

  it.each([
    ["not JSON", "{nope"],
    ["JSON that is not an object", "[1,2]"],
    ["an object without a context", "{}"],
  ])("answers 400 to a body that is %s, never an accept", async (_name, body) => {
    const { deps, domainOwner } = routeDeps()
    const res = await call(createMtaHookRoutes(deps), body)
    expect(res.status).toBe(400)
    expect(domainOwner).not.toHaveBeenCalled()
  })

  it("answers 500 when the decision throws, so Stalwart tempfails", async () => {
    const { deps, log } = routeDeps()
    deps.domainOwner = async () => {
      throw new Error("connection terminated")
    }
    const res = await call(createMtaHookRoutes(deps), rcpt("john@acme.test"))
    expect(res.status).toBe(500)
    expect(await res.json()).not.toHaveProperty("action")
    expect(log.error).toHaveBeenCalled()
  })

  it("is mounted at /internal/mta-hook, and answers 503 until it is configured", async () => {
    const { deps } = routeDeps()
    const configured = createApp({ mtaHook: deps })
    const open = await configured.request("/internal/mta-hook", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(rcpt("john@acme.test")),
    })
    expect(open.status).toBe(200)

    const bare = createApp({})
    const closed = await bare.request("/internal/mta-hook", {
      method: "POST",
      body: JSON.stringify(rcpt("john@acme.test")),
    })
    expect(closed.status).toBe(503)
  })
})
