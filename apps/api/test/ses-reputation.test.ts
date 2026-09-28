import { createSign, generateKeyPairSync } from "node:crypto"
import { describe, expect, it, mock } from "bun:test"
import { createSesWebhooks } from "../src/routes/ses-events.js"
import { parseFindingEvent, type FindingEvent } from "../src/ses-status/event.js"
import { reputationService, type FindingNotice } from "../src/ses-status/reputation.js"
import {
  pollReputation,
  type ReputationReader,
} from "../src/ses-status/reputation-poll.js"
import type {
  FindingOpen,
  OpenFinding,
  ReputationStore,
} from "../src/ses-status/reputation-store.js"
import { canonicalString, type SnsMessage } from "../src/webhooks/sns.js"

/**
 * SES reputation findings (#158).
 *
 * ⚠ THE FAILURES WORTH GUARDING: one finding recorded twice (event and poll
 * disagree on its time), a late Resolved closing the episode after it, and the
 * owner emailed on every redelivery - or never, because the first email failed.
 */

const WORKSPACE = "0190a3e4-5b6c-7d8e-9f00-112233445566"
const TENANT = `i10-${WORKSPACE}`
const TENANT_ARN = `arn:aws:ses:eu-central-1:699073937874:tenant/${TENANT}/tn-abc`

/** The reputation-finding example from the SES tenants guide, pointed at us. */
const advisorEvent = (over: Record<string, unknown> = {}) => ({
  "detail-type": "Advisor Recommendation Status Open",
  source: "aws.ses",
  account: "699073937874",
  time: "2026-09-28T10:00:00Z",
  region: "eu-central-1",
  resources: [TENANT_ARN],
  detail: {
    version: "1.0.0",
    data: "The bounce rate exceeded 15.0% based on a representative volume of 197 emails.",
    metadata: { impact: "HIGH", type: "BOUNCE" },
  },
  ...over,
})

describe("parseFindingEvent", () => {
  it("reads the tenant, type, impact, description and the envelope time", () => {
    expect(parseFindingEvent(advisorEvent())).toEqual({
      sesTenant: TENANT,
      type: "bounce",
      impact: "high",
      status: "open",
      description:
        "The bounce rate exceeded 15.0% based on a representative volume of 197 emails.",
      at: new Date("2026-09-28T10:00:00Z"),
    })
  })

  it("reads a resolve, with or without an impact", () => {
    const resolved = advisorEvent({
      "detail-type": "Advisor Recommendation Status Resolved",
    })
    expect(parseFindingEvent(resolved)?.status).toBe("resolved")
    const bare = {
      ...resolved,
      detail: { version: "1.0.0", metadata: { type: "BOUNCE" } },
    }
    expect(parseFindingEvent(bare)).toMatchObject({ status: "resolved", impact: null })
  })

  // An open finding with no impact cannot be keyed; the poll records it.
  it("drops an open finding that names no impact", () => {
    expect(
      parseFindingEvent({
        ...advisorEvent(),
        detail: { metadata: { type: "BOUNCE" } },
      }),
    ).toBeNull()
  })

  it("leaves status changes to the status parser", () => {
    expect(
      parseFindingEvent(advisorEvent({ "detail-type": "Sending Status Disabled" })),
    ).toBeNull()
  })
})

/**
 * The store's contract in memory: one open row per (type, impact), a stale
 * Open refused, a Resolved only closing what opened before it.
 */
const memoryStore = () => {
  type Row = OpenFinding & { resolvedAt: Date | null }
  const rows: Row[] = []
  let seq = 0
  const store: ReputationStore = {
    open: mock(async (f: FindingOpen) => {
      const same = (r: Row) => r.type === f.type && r.impact === f.impact
      const open = rows.find((r) => same(r) && !r.resolvedAt)
      if (
        f.source === "event" &&
        !open &&
        rows.some((r) => same(r) && r.resolvedAt && r.resolvedAt >= f.at)
      ) {
        return { outcome: "stale" as const }
      }
      if (open) {
        open.lastSeenAt = f.at > open.lastSeenAt ? f.at : open.lastSeenAt
        open.openedAt = f.at < open.openedAt ? f.at : open.openedAt
        return { outcome: "seen" as const, id: open.id, notifiedAt: open.notifiedAt }
      }
      const row: Row = {
        id: `f${++seq}`,
        type: f.type,
        impact: f.impact,
        description: f.description,
        openedAt: f.at,
        lastSeenAt: f.at,
        notifiedAt: null,
        resolvedAt: null,
      }
      rows.push(row)
      return { outcome: "opened" as const, id: row.id, notifiedAt: null }
    }),
    resolve: mock(async (_t, type, impact, at) => {
      let n = 0
      for (const r of rows) {
        if (r.type !== type || r.resolvedAt || r.openedAt > at) continue
        if (impact && r.impact !== impact) continue
        r.resolvedAt = at
        n += 1
      }
      return n
    }),
    openFindings: mock(async () => rows.filter((r) => !r.resolvedAt)),
    markNotified: mock(async (_t, id) => {
      const row = rows.find((r) => r.id === id)
      if (row) row.notifiedAt = new Date()
    }),
    counts: mock(async () => ({
      sends: 0,
      hardBounces: 0,
      softBounces: 0,
      complaints: 0,
    })),
    snapshot: mock(async () => {}),
  }
  return { store, rows }
}

const finding = (over: Partial<FindingEvent> = {}): FindingEvent => ({
  sesTenant: TENANT,
  type: "bounce",
  impact: "high",
  status: "open",
  description: "The bounce rate exceeded 15.0%.",
  at: new Date("2026-09-28T10:00:00Z"),
  ...over,
})

describe("reputationService", () => {
  it("opens a HIGH finding, alerts, and emails the owner once", async () => {
    const { store } = memoryStore()
    const notice: FindingNotice = { sendFinding: mock(async () => {}) }
    const alert = mock()
    const service = reputationService({ store, notice, alert })

    expect(await service.apply(finding(), "event")).toBe("opened")
    expect(notice.sendFinding).toHaveBeenCalledWith({
      tenantId: WORKSPACE,
      type: "bounce",
      description: "The bounce rate exceeded 15.0%.",
      key: "ses-finding:f1",
    })
    expect(alert).toHaveBeenCalledTimes(1)

    // SNS redelivery, then the poll with SES's earlier CreatedTimestamp.
    expect(await service.apply(finding(), "event")).toBe("seen")
    expect(
      await service.apply(finding({ at: new Date("2026-09-28T09:40:00Z") }), "poll"),
    ).toBe("seen")
    expect(notice.sendFinding).toHaveBeenCalledTimes(1)
    expect(alert).toHaveBeenCalledTimes(1)
  })

  it("shows a LOW finding without emailing anybody", async () => {
    const { store, rows } = memoryStore()
    const notice: FindingNotice = { sendFinding: mock(async () => {}) }
    const alert = mock()
    await reputationService({ store, notice, alert }).apply(
      finding({ impact: "low" }),
      "event",
    )
    expect(rows).toHaveLength(1)
    expect(notice.sendFinding).not.toHaveBeenCalled()
    expect(alert).not.toHaveBeenCalled()
  })

  // ⚠ Keyed on notified_at: a failed email is retried, a sent one never is.
  it("retries the email on the next report when the first one failed", async () => {
    const { store } = memoryStore()
    let fail = true
    const notice: FindingNotice = {
      sendFinding: mock(async () => {
        if (fail) throw new Error("clerk is down")
      }),
    }
    const log = { error: mock(), warn: mock() }
    const service = reputationService({ store, notice, log })

    expect(await service.apply(finding(), "event")).toBe("opened")
    expect(log.error).toHaveBeenCalled()
    fail = false
    await service.apply(finding(), "poll")
    await service.apply(finding(), "poll")
    expect(notice.sendFinding).toHaveBeenCalledTimes(2)
  })

  it("resolves, and a late Open for the resolved episode is stale", async () => {
    const { store } = memoryStore()
    const service = reputationService({ store })
    await service.apply(finding(), "event")
    expect(
      await service.apply(
        finding({ status: "resolved", at: new Date("2026-09-28T12:00:00Z") }),
        "event",
      ),
    ).toBe("resolved")
    expect(await service.apply(finding(), "event")).toBe("stale")
  })

  it("keeps a LOW and a HIGH finding of one type apart", async () => {
    const { store, rows } = memoryStore()
    const service = reputationService({ store })
    await service.apply(finding({ impact: "low" }), "event")
    await service.apply(finding({ impact: "high" }), "event")
    await service.apply(
      finding({
        impact: "low",
        status: "resolved",
        at: new Date("2026-09-28T11:00:00Z"),
      }),
      "event",
    )
    expect(rows.filter((r) => !r.resolvedAt).map((r) => r.impact)).toEqual(["high"])
  })

  it("alerts at error level, and stores nothing, for our own tenant", async () => {
    const { store } = memoryStore()
    const alert = mock()
    expect(
      await reputationService({ store, alert }).apply(
        finding({ sesTenant: "i10-internal" }),
        "event",
      ),
    ).toBe("system")
    expect(alert).toHaveBeenCalledWith(expect.any(String), "error", expect.anything())
    expect(store.open).not.toHaveBeenCalled()
  })

  it("ignores a tenant that is not ours, and a deleted workspace", async () => {
    const { store } = memoryStore()
    expect(
      await reputationService({ store }).apply(
        finding({ sesTenant: "made-by-hand" }),
        "event",
      ),
    ).toBe("ignored")
    store.open = mock(async () => {
      throw Object.assign(new Error("fk"), { code: "23503" })
    })
    expect(await reputationService({ store }).apply(finding(), "event")).toBe("ignored")
  })

  it("reconciles: opens what SES lists, resolves what it no longer does", async () => {
    const { store, rows } = memoryStore()
    const service = reputationService({ store })
    await service.apply(finding({ type: "complaint" }), "event")

    const now = new Date("2026-09-29T03:17:00Z")
    const summary = await service.reconcile(
      TENANT,
      [
        {
          type: "bounce",
          impact: "high",
          description: "The bounce rate exceeded 15.0%.",
          createdAt: new Date("2026-09-28T09:00:00Z"),
        },
      ],
      now,
    )
    expect(summary).toEqual({ opened: 1, resolved: 1 })
    expect(rows.find((r) => r.type === "complaint")?.resolvedAt).toEqual(now)
    expect(rows.find((r) => r.type === "bounce")?.openedAt).toEqual(
      new Date("2026-09-28T09:00:00Z"),
    )
  })
})

describe("pollReputation", () => {
  const reader = (failing = false): ReputationReader => ({
    tenants: async () => [
      { name: TENANT, arn: TENANT_ARN },
      { name: "i10-internal", arn: "arn:aws:ses:eu-central-1:1:tenant/i10-internal/x" },
    ],
    read: async (arn) => {
      if (failing && arn === TENANT_ARN) throw new Error("AccessDenied")
      return { open: [], sendingStatus: "enabled", impact: null, policy: "standard" }
    },
  })

  it("snapshots every workspace with 24h and 7d counts, never our own tenant", async () => {
    const { store } = memoryStore()
    const service = reputationService({ store })
    const now = new Date("2026-09-29T03:17:00Z")

    const summary = await pollReputation({
      reader: reader(),
      service,
      store,
      now: () => now,
    })
    expect(summary).toEqual({
      checked: 2,
      opened: 0,
      resolved: 0,
      snapshots: 1,
      failed: 0,
    })
    expect(store.counts).toHaveBeenCalledWith(
      WORKSPACE,
      new Date("2026-09-28T03:17:00Z"),
    )
    expect(store.counts).toHaveBeenCalledWith(
      WORKSPACE,
      new Date("2026-09-22T03:17:00Z"),
    )
    expect(store.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: WORKSPACE,
        day: "2026-09-29",
        policy: "standard",
      }),
    )
  })

  it("counts a tenant it could not read and carries on", async () => {
    const { store } = memoryStore()
    const summary = await pollReputation({
      reader: reader(true),
      service: reputationService({ store }),
      store,
    })
    expect(summary).toMatchObject({ checked: 1, failed: 1 })
  })
})

describe("the SES webhook routes findings", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString()

  const signed = (payload: unknown): SnsMessage => {
    const message = {
      Type: "Notification",
      MessageId: "sns-1",
      TopicArn: "arn:aws:sns:eu-central-1:699073937874:i10-ses-events",
      Message: JSON.stringify(payload),
      Timestamp: "2026-09-28T10:00:00.000Z",
      SignatureVersion: "2",
      SigningCertURL: "https://sns.eu-central-1.amazonaws.com/cert.pem",
      Signature: "",
    } as SnsMessage
    const signer = createSign("RSA-SHA256")
    signer.update(
      canonicalString(message, [
        "Message",
        "MessageId",
        "Subject",
        "Timestamp",
        "TopicArn",
        "Type",
      ]),
      "utf8",
    )
    return { ...message, Signature: signer.sign(privateKey, "base64") }
  }

  const post = (reputation: { apply: ReturnType<typeof mock> }, body: unknown) =>
    createSesWebhooks({
      events: { ingest: mock() } as never,
      log: { info: mock(), warn: mock(), error: mock() },
      fetchCertificate: async () => pem,
      tenantStatus: { apply: mock() } as never,
      reputation: reputation as never,
    }).request("/ses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  it("hands a verified Advisor event to the reputation service", async () => {
    const apply = mock(async () => "opened")
    const res = await post({ apply }, signed(advisorEvent()))
    expect(res.status).toBe(200)
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ sesTenant: TENANT, type: "bounce", impact: "high" }),
      "event",
    )
  })

  it("answers 500 so SNS redelivers when the finding cannot be written", async () => {
    const apply = mock(async () => {
      throw new Error("db down")
    })
    expect((await post({ apply }, signed(advisorEvent()))).status).toBe(500)
  })
})
