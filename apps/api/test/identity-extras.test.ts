import { describe, expect, it } from "bun:test"
import { webhookEventData } from "@repo/contracts"
import { auditTap, tapped } from "../src/identity/audit-tap.js"
import { deprovision, type DeprovisionDeps } from "../src/identity/managed.js"
import {
  healthOf,
  type ConnectionHealthStore,
  type HealthCounts,
} from "../src/identity/health.js"
import type { IdentityWebhooks } from "../src/webhooks/identity-events.js"
import { memoryMail } from "./identity-mail-fakes.js"
import {
  CONNECTION,
  ORG,
  TENANT,
  log,
  memoryClerk,
  memoryStore,
} from "./identity-fakes.js"

/**
 * #345 slice B: the identity events as customer webhooks, and connection
 * health. Every payload that leaves is parsed by the strict schema the catalog
 * publishes, so a field added in code and not in the contract fails here.
 */

const NOW = new Date("2026-10-28T12:00:00Z")

type Emitted = { type: string; data: Record<string, unknown> }

function world(over: { counts?: Partial<HealthCounts>; status?: string | null } = {}) {
  const store = memoryStore()
  const emitted: Emitted[] = []
  let claims = 0
  let allowClaim = true
  const webhooks: IdentityWebhooks = {
    async emit(_tenantId, type, data, at = NOW) {
      emitted.push({ type, data: { ...data, created_at: at.toISOString() } })
    },
  }
  const health: ConnectionHealthStore = {
    async counts() {
      return {
        lastSuccessAt: NOW,
        failuresLast15Minutes: 1,
        failuresLastHour: 1,
        failuresLast24Hours: 1,
        ...over.counts,
      }
    },
    async claimAlert() {
      claims++
      const ok = allowClaim
      allowClaim = false
      return ok
    },
  }
  const certificateAlerts: unknown[] = []
  const tap = auditTap({
    webhooks,
    health,
    alerts: {
      bypassUsed: async () => {},
      certificateExpiring: async (_t, input) => void certificateAlerts.push(input),
    },
    connectionStatus: async () => (over.status === undefined ? "active" : over.status),
    log,
    now: () => NOW,
  })
  return {
    store,
    emitted,
    certificateAlerts,
    tap,
    claims: () => claims,
    tapped: tapped(store.store, tap),
  }
}

/** The payload as the catalog describes it, or the schema's complaint. */
const valid = (e: Emitted) => {
  const parsed = webhookEventData[e.type as keyof typeof webhookEventData].safeParse(
    e.data,
  )
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues))
  return true
}

describe("member.provisioned", () => {
  it("fires when somebody becomes managed, whichever way", async () => {
    const w = world()
    for (const reason of ["jit", "scim", "claimed", "linked"])
      await w.tapped.record(TENANT, {
        type: "managed.claimed",
        subjectUserId: "user_ada",
        connectionId: reason === "scim" ? null : CONNECTION,
        reason,
        data: { email: "ada@acme.test", notified: false },
      })
    expect(w.emitted.map((e) => e.type)).toEqual(Array(4).fill("member.provisioned"))
    expect(w.emitted.every(valid)).toBe(true)
    expect(w.emitted.map((e) => e.data.source)).toEqual([
      "jit",
      "scim",
      "claimed",
      "linked",
    ])
  })

  it("carries ids and a reason, never the address or anything in the audit data", async () => {
    const w = world()
    await w.tapped.record(TENANT, {
      type: "managed.claimed",
      subjectUserId: "user_ada",
      connectionId: CONNECTION,
      reason: "jit",
      data: { email: "ada@acme.test", token: "tok_secret", assertion: "<xml/>" },
    })
    const text = JSON.stringify(w.emitted)
    expect(text).not.toContain("ada@acme.test")
    expect(text).not.toContain("tok_secret")
    expect(text).not.toContain("<xml/>")
  })

  it("is not raised for an event that is only a step on the way", async () => {
    const w = world()
    await w.tapped.record(TENANT, {
      type: "jit.provisioned",
      subjectUserId: "user_ada",
    })
    await w.tapped.record(TENANT, {
      type: "managed.enforced",
      subjectUserId: "user_ada",
    })
    expect(w.emitted).toEqual([])
  })
})

describe("member.deprovisioned", () => {
  function deprovisionWorld(keys: Array<{ id: string; name: string }> | "throws") {
    const w = world()
    const clerk = memoryClerk()
    const mail = memoryMail()
    const keyCalls: string[] = []
    const deps: DeprovisionDeps = {
      store: w.tapped,
      clerk: clerk.clerk,
      log,
      mail: mail.lifecycle,
      workspaceOrg: async () => ORG,
      authorize: async () => "ok",
      removeMembership: async () => "removed",
      keysCreatedBy: async (_t, userId) => {
        keyCalls.push(userId)
        if (keys === "throws") throw new Error("db down")
        return keys
      },
    }
    w.store.managed.set("user_ada", {
      clerkUserId: "user_ada",
      tenantId: TENANT,
      connectionId: CONNECTION,
      reason: "claimed",
      emails: ["ada@acme.test"],
    })
    return { w, deps, keyCalls, clerk }
  }

  const run = (deps: DeprovisionDeps) =>
    deprovision(deps, {
      tenantId: TENANT,
      clerkUserId: "user_ada",
      actorUserId: "user_admin",
      cause: "admin",
    })

  it("records the keys they created on the audit event and fires the webhook with them", async () => {
    const { w, deps } = deprovisionWorld([{ id: "key-1", name: "Production" }])
    expect((await run(deps)).outcome).toBe("membership")
    expect(w.store.events.find((e) => e.type === "member.deprovisioned")).toMatchObject(
      {
        connectionId: CONNECTION,
        data: { apiKeys: [{ id: "key-1", name: "Production" }] },
      },
    )
    const sent = w.emitted.find((e) => e.type === "member.deprovisioned")!
    expect(valid(sent)).toBe(true)
    expect(sent.data).toMatchObject({
      user_id: "user_ada",
      connection_id: CONNECTION,
      mode: "membership",
      cause: "admin",
      actor_user_id: "user_admin",
      api_keys: [{ id: "key-1", name: "Production" }],
    })
  })

  it("never revokes anything by itself", async () => {
    const { deps, clerk } = deprovisionWorld([{ id: "key-1", name: "Production" }])
    await run(deps)
    // The only revoke-shaped calls are sessions; no key store is even offered.
    expect(clerk.calls.filter((c) => !c.startsWith("revokeSession"))).toEqual([])
  })

  it("still deprovisions when the keys cannot be listed, and says so", async () => {
    const { w, deps } = deprovisionWorld("throws")
    expect((await run(deps)).outcome).toBe("membership")
    expect(w.store.events.find((e) => e.type === "member.deprovisioned")).toMatchObject(
      {
        data: { apiKeys: [], apiKeysUnknown: true },
      },
    )
  })

  it("does not fire for a refusal", async () => {
    const { w, deps } = deprovisionWorld([])
    deps.removeMembership = async () => "last_owner"
    expect((await run(deps)).outcome).toBe("last_owner")
    expect(w.emitted).toEqual([])
  })
})

describe("sso.connection.failed", () => {
  const failure = (reason = "signature_invalid") => ({
    type: "sign_in.failed",
    connectionId: CONNECTION,
    reason,
    data: { attemptId: "a1", subject: "secret-subject" },
  })

  it("fires on a failure, once per connection per 15 minutes", async () => {
    const w = world()
    await w.tapped.record(TENANT, failure())
    await w.tapped.record(TENANT, failure())
    await w.tapped.record(TENANT, failure("assertion_expired"))
    expect(w.claims()).toBe(3)
    expect(w.emitted).toHaveLength(1)
    expect(valid(w.emitted[0]!)).toBe(true)
    expect(w.emitted[0]!.data).toMatchObject({
      connection_id: CONNECTION,
      reason: "signature_invalid",
      trigger: "sign_in_failed",
    })
    // Not the IdP subject, nor any attempt detail.
    expect(JSON.stringify(w.emitted)).not.toContain("secret-subject")
  })

  it("reports a spike as a failing connection", async () => {
    const w = world({
      counts: {
        failuresLast15Minutes: 25,
        failuresLastHour: 30,
        failuresLast24Hours: 40,
      },
    })
    await w.tapped.record(TENANT, failure())
    expect(valid(w.emitted[0]!)).toBe(true)
    expect(w.emitted[0]!.data).toMatchObject({
      trigger: "failure_spike",
      failures_last_hour: 30,
      failures_last_24h: 40,
    })
  })

  it("reports a connection that has not worked for a day", async () => {
    const w = world({
      counts: {
        lastSuccessAt: new Date(NOW.getTime() - 30 * 3_600_000),
        failuresLast15Minutes: 1,
        failuresLastHour: 1,
        failuresLast24Hours: 4,
      },
    })
    await w.tapped.record(TENANT, failure())
    expect(w.emitted[0]!.data).toMatchObject({ trigger: "no_success" })
    expect(valid(w.emitted[0]!)).toBe(true)
  })

  it("does not count a stranger's replay or second tab", async () => {
    const w = world()
    await w.tapped.record(TENANT, failure("wrong_browser"))
    await w.tapped.record(TENANT, failure("attempt_used"))
    expect(w.claims()).toBe(0)
    expect(w.emitted).toEqual([])
  })

  it("says nothing about a connection that is not live", async () => {
    const w = world({ status: "testing" })
    await w.tapped.record(TENANT, failure())
    expect(w.emitted).toEqual([])
  })

  it("also fires when the IdP could not be reached", async () => {
    const w = world()
    await w.tapped.record(TENANT, {
      type: "sign_in.idp_unavailable",
      connectionId: CONNECTION,
      reason: "timeout",
    })
    expect(w.emitted.map((e) => e.type)).toEqual(["sso.connection.failed"])
  })
})

describe("sso.certificate.expiring", () => {
  it("fires with the threshold crossed, and tells the managers", async () => {
    const w = world()
    await w.tapped.record(TENANT, {
      type: "sso.certificate.expiring",
      connectionId: CONNECTION,
      reason: "7_days",
      data: {
        fingerprint: "ab".repeat(32),
        notAfter: "2026-11-04T12:00:00.000Z",
        days: 7,
      },
    })
    expect(valid(w.emitted[0]!)).toBe(true)
    expect(w.emitted[0]!.data).toMatchObject({ days: 7, connection_id: CONNECTION })
    expect(w.certificateAlerts).toEqual([
      {
        connectionId: CONNECTION,
        fingerprint: "ab".repeat(32),
        notAfter: new Date("2026-11-04T12:00:00.000Z"),
        days: 7,
      },
    ])
  })

  it("ignores an event that is missing what the payload needs", async () => {
    const w = world()
    await w.tapped.record(TENANT, {
      type: "sso.certificate.expiring",
      connectionId: CONNECTION,
      data: {},
    })
    expect(w.emitted).toEqual([])
  })
})

describe("a failing follow-up never fails the flow", () => {
  it("lets record succeed when the webhook and the alert both throw", async () => {
    const store = memoryStore()
    const tap = auditTap({
      webhooks: {
        emit: async () => {
          throw new Error("redis down")
        },
      },
      alerts: {
        bypassUsed: async () => {},
        certificateExpiring: async () => {
          throw new Error("mail down")
        },
      },
      connectionStatus: async () => "active",
      log,
    })
    const wrapped = tapped(store.store, tap)
    await wrapped.record(TENANT, {
      type: "managed.claimed",
      subjectUserId: "user_ada",
      reason: "jit",
    })
    await wrapped.record(TENANT, {
      type: "sso.certificate.expiring",
      connectionId: CONNECTION,
      data: { fingerprint: "f", notAfter: "2026-11-04T12:00:00.000Z", days: 1 },
    })
    // Both audit rows are written regardless.
    expect(store.events.map((e) => e.type)).toEqual([
      "managed.claimed",
      "sso.certificate.expiring",
    ])
  })
})

describe("connection health", () => {
  const counts = (over: Partial<HealthCounts> = {}): HealthCounts => ({
    lastSuccessAt: NOW,
    failuresLast15Minutes: 0,
    failuresLastHour: 0,
    failuresLast24Hours: 0,
    ...over,
  })

  it("is healthy and quiet by default", () => {
    expect(healthOf(counts(), "active", NOW)).toMatchObject({
      failing: false,
      reason: null,
      failuresLastHour: 0,
      lastSuccessAt: NOW.toISOString(),
    })
  })

  it("needs more than ten failures in 15 minutes to be a spike", () => {
    expect(healthOf(counts({ failuresLast15Minutes: 10 }), "active", NOW).failing).toBe(
      false,
    )
    expect(
      healthOf(counts({ failuresLast15Minutes: 11 }), "active", NOW),
    ).toMatchObject({ failing: true, reason: "failure_spike" })
  })

  it("raises the bar to three times the trailing hourly average", () => {
    // 23 failures in the 23 hours before the last one: 1 an hour, so the floor holds.
    const base = {
      failuresLastHour: 3,
      failuresLast24Hours: 3 + 23 * 8,
    }
    // 8 an hour on average: 3x = 24, so 20 in 15 minutes is no spike...
    expect(
      healthOf(counts({ ...base, failuresLast15Minutes: 20 }), "active", NOW).failing,
    ).toBe(false)
    // ...and 25 is.
    expect(
      healthOf(counts({ ...base, failuresLast15Minutes: 25 }), "active", NOW).failing,
    ).toBe(true)
  })

  it("is failing after a day without a success when failures happened", () => {
    const old = new Date(NOW.getTime() - 25 * 3_600_000)
    expect(
      healthOf(
        counts({ lastSuccessAt: old, failuresLast24Hours: 2, failuresLastHour: 0 }),
        "active",
        NOW,
      ),
    ).toMatchObject({ failing: true, reason: "no_success" })
    expect(
      healthOf(counts({ lastSuccessAt: null, failuresLast24Hours: 1 }), "active", NOW)
        .reason,
    ).toBe("no_success")
  })

  it("is not failing for a connection nobody tried to use", () => {
    expect(healthOf(counts({ lastSuccessAt: null }), "active", NOW).failing).toBe(false)
  })

  it("cannot fail unless it is active", () => {
    const bad = counts({ failuresLast15Minutes: 50, failuresLast24Hours: 50 })
    for (const status of ["draft", "testing", "disabled"])
      expect(healthOf(bad, status, NOW).failing).toBe(false)
  })
})
