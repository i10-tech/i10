import { describe, expect, test } from "bun:test"
import { encodeShape, parseShapes, shapeFromText } from "@/lib/shapes"
import { overviewShape, type OverviewData } from "@/lib/shapes/overview"
import { emailShape, emailShapeFromRow, type EmailData } from "@/lib/shapes/email"
import {
  broadcastSeed,
  broadcastShape,
  type BroadcastData,
} from "@/lib/shapes/broadcast"
import {
  getSeededShape,
  seedShape,
  clearSeededShapes,
} from "@/components/list/remembered-shapes"
import type { BroadcastDetail, EmailDetail, EmailRow } from "@/lib/types"

describe("overviewShape", () => {
  // ⚠ A FIRST VISIT KNOWS THE BANNER (2026-11-09): without it the cards were
  // pushed down by the banner the moment the page landed.
  test("a first visit takes the banner from sendingAtRisk and the list from emails", () => {
    expect(overviewShape.fromCounts!({ emails: 3, sendingAtRisk: 1 })).toEqual({
      recent: 3,
      banner: "status",
      suggestions: false,
      days: 30,
    })
    expect(overviewShape.fromCounts!({ emails: 40, sendingAtRisk: 0 })).toMatchObject({
      recent: 8,
      banner: "none",
    })
    expect(overviewShape.fromCounts!({ domains: 2 })).toBeNull()
  })

  const baseData: OverviewData = {
    overview: {
      totals: {
        sent: 100,
        delivered: 98,
        bounced: 1,
        complained: 0,
        delayed: 0,
        failed: 1,
      },
      series: [],
      counts: {
        domains: 2,
        verifiedDomains: 1,
        apiKeys: 3,
        webhookEndpoints: 0,
        suppressions: 5,
      },
    },
    recent: [
      {
        id: "m_1",
        created_at: "2026-11-01T00:00:00Z",
        from: "sender@example.com",
        to: ["rcpt@example.com"],
        subject: "Test",
        status: "delivered",
        last_event: "delivered",
        scheduled_at: null,
        sent_at: "2026-11-01T00:00:01Z",
        last_error: null,
      },
    ],
    sendingStatus: {
      status: "enabled",
      health: "healthy",
      cause: null,
      changed_at: null,
      findings: [],
      hold: null,
    },
    capacity: null,
    days: 30,
  }

  test("derives clean shape with no banners when healthy", () => {
    const shape = overviewShape.of(baseData)
    expect(shape).toEqual({
      recent: 1,
      banner: "none",
      suggestions: false,
      days: 30,
    })
  })

  test("derives status banner when sending health is at risk", () => {
    const shape = overviewShape.of({
      ...baseData,
      sendingStatus: {
        status: "enabled",
        health: "at_risk",
        cause: null,
        changed_at: null,
        findings: [
          {
            type: "bounce",
            impact: "high",
            description: null,
            opened_at: "2026-11-01T00:00:00Z",
          },
        ],
        hold: null,
      },
    })
    expect(shape.banner).toBe("status")
  })

  test("derives capacity banner when capacity threshold crossed", () => {
    const shape = overviewShape.of({
      ...baseData,
      capacity: {
        members: 9,
        invitations: 0,
        limit: 10,
        free: 1,
        full: false,
        reasons: [],
        can_upgrade: true,
        personal: false,
        patterns: [],
        alert: { level: 80, alerted_at: "2026-11-01T00:00:00Z" },
      },
    })
    expect(shape.banner).toBe("capacity")
  })

  test("derives both banners when both are active", () => {
    const shape = overviewShape.of({
      ...baseData,
      sendingStatus: {
        status: "disabled",
        health: "paused",
        cause: "bounces",
        changed_at: null,
        findings: [],
        hold: null,
      },
      capacity: {
        members: 10,
        invitations: 0,
        limit: 10,
        free: 0,
        full: true,
        reasons: [],
        can_upgrade: true,
        personal: false,
        patterns: [],
        alert: { level: 100, alerted_at: "2026-11-01T00:00:00Z" },
      },
    })
    expect(shape.banner).toBe("both")
  })

  test("round-trips through cookies", () => {
    const shape = { recent: 4, banner: "status" as const, suggestions: true, days: 14 }
    const cookies = [
      { name: "i10-shape-overview", value: encodeShape("tenant-a", shape) },
    ]
    const text = parseShapes(cookies, "tenant-a").overview
    expect(shapeFromText(overviewShape, text)).toEqual(shape)
  })

  test("falls back on invalid input", () => {
    expect(shapeFromText(overviewShape, "{bad json")).toEqual(overviewShape.fallback)
    expect(shapeFromText(overviewShape, JSON.stringify({ recent: -5 }))).toEqual(
      overviewShape.fallback,
    )
  })
})

describe("emailShape", () => {
  const emailDetail: EmailDetail = {
    id: "msg_123",
    created_at: "2026-11-01T00:00:00Z",
    from: "alice@example.com",
    to: ["bob@example.com", "carol@example.com"],
    cc: ["dave@example.com"],
    bcc: [],
    reply_to: ["reply@example.com"],
    subject: "Hello World",
    status: "failed",
    last_event: "bounced",
    scheduled_at: null,
    sent_at: "2026-11-01T00:00:01Z",
    last_error: "SMTP 550 Mailbox not found",
    html: "<p>Hello</p>",
    text: "Hello",
    headers: { "X-Test": "true" },
    attachments: [{ filename: "doc.pdf", content_type: "application/pdf", size: 1024 }],
    events: [{ type: "bounced", occurred_at: "2026-11-01T00:00:02Z", payload: {} }],
    domain_id: "dom_1",
    api_key_id: "key_1",
    provider_message_id: "prov_1",
    attempts: 2,
    broadcast_id: "bc_456",
    tags: { env: "prod", campaign: "launch" },
  }

  test("derives exact shape from full email detail", () => {
    const data: EmailData = { email: emailDetail }
    const shape = emailShape.of(data)
    expect(shape.to).toBe(2)
    expect(shape.cc).toBe(1)
    expect(shape.bcc).toBe(0)
    expect(shape.replyTo).toBe(1)
    expect(shape.attachments).toBe(1)
    expect(shape.error).toBe(true)
    expect(shape.tags).toBe(2)
    expect(shape.broadcast).toBe(true)
    expect(shape.scheduled).toBe(false)
    expect(shape.sent).toBe(true)
    expect(shape.attempts).toBe(2)
  })

  test("emailShapeFromRow creates seed shape from list row data", () => {
    const row: EmailRow = {
      id: "msg_123",
      created_at: "2026-11-01T00:00:00Z",
      from: "alice@example.com",
      to: ["bob@example.com"],
      subject: "Hello",
      status: "sent",
      last_event: "delivered",
      scheduled_at: "2026-11-01T00:00:00Z",
      sent_at: "2026-11-01T00:00:05Z",
      last_error: null,
    }
    const seed = emailShapeFromRow(row)
    expect(seed).toEqual({
      to: 1,
      cc: 0,
      bcc: 0,
      replyTo: 0,
      attachments: 0,
      steps: 3,
      error: false,
      tags: 0,
      broadcast: false,
      scheduled: true,
      sent: true,
      attempts: 1,
      log: 3,
      provider: true,
    })
  })

  test("seeding email shape round-trips through seed store", () => {
    clearSeededShapes()
    const seeded = emailShapeFromRow({
      id: "msg_seed",
      created_at: "2026-11-01T00:00:00Z",
      from: "a@b.com",
      to: ["c@d.com"],
      subject: "Seeded",
      status: "queued",
      last_event: "queued",
      scheduled_at: null,
      sent_at: null,
      last_error: null,
    })
    seedShape(emailShape, "msg_seed", seeded)
    expect(getSeededShape(emailShape, "msg_seed")).toEqual(seeded)
    expect(getSeededShape(emailShape, "unknown")).toEqual(emailShape.fallback)
  })

  test("parse accepts partial or seed inputs and supplies defaults", () => {
    const parsed = emailShape.parse({
      to: 3,
      error: true,
      broadcast: true,
    })
    expect(parsed).toEqual({
      to: 3,
      cc: 0,
      bcc: 0,
      replyTo: 0,
      attachments: 0,
      steps: 3,
      error: true,
      tags: 0,
      broadcast: true,
      scheduled: false,
      sent: true,
      attempts: 1,
      log: 3,
      provider: false,
    })
  })

  test("the event log counts its rows, folding opens and clicks", () => {
    const events = [
      { type: "delivered", occurred_at: "2026-11-01T00:00:02Z", payload: {} },
      { type: "opened", occurred_at: "2026-11-01T00:00:03Z", payload: {} },
      { type: "opened", occurred_at: "2026-11-01T00:00:04Z", payload: {} },
      { type: "clicked", occurred_at: "2026-11-01T00:00:05Z", payload: {} },
    ]
    const shape = emailShape.of({
      email: { ...emailDetail, events, scheduled_at: "2026-11-01T00:00:00Z" },
    })
    // accepted + scheduled + delivered + one opened + one clicked
    expect(shape.log).toBe(5)
    expect(shape.provider).toBe(true)
  })

  test("a cookie from before `log` and `provider` still reads", () => {
    const parsed = emailShape.parse({ to: 2, steps: 4 })
    expect(parsed?.log).toBe(3)
    expect(parsed?.provider).toBe(false)
  })
})

describe("broadcastShape", () => {
  const broadcastDetail: BroadcastDetail = {
    id: "bc_1",
    name: "Spring Newsletter",
    subject: "Updates",
    preview_text: "News",
    from: "newsletter@example.com",
    reply_to: [],
    segment_id: "seg_1",
    segment_name: "Subscribers",
    topic_id: null,
    status: "sent",
    created_at: "2026-11-01T00:00:00Z",
    scheduled_at: null,
    sent_at: "2026-11-01T01:00:00Z",
    recipient_count: 100,
    html: "<p>Hello</p>",
    text: "Hello",
    stats: { total: 100, delivered: 95, bounced: 3, complained: 0, failed: 2 },
  }

  test("derives status from broadcast detail", () => {
    const data: BroadcastData = {
      broadcast: broadcastDetail,
      segments: [],
      topics: [],
      domains: [],
    }
    const shape = broadcastShape.of(data)
    // created, sending, sent
    expect(shape).toEqual({ status: "sent", steps: 3, subject: true })
  })

  test("a scheduled time adds a step, and no subject is no subtitle", () => {
    const shape = broadcastShape.of({
      broadcast: {
        ...broadcastDetail,
        scheduled_at: "2026-11-01T00:30:00Z",
        subject: "",
      },
      segments: [],
      topics: [],
      domains: [],
    })
    expect(shape.steps).toBe(4)
    expect(shape.subject).toBe(false)
  })

  test("a cookie from before `steps` and `subject` still reads", () => {
    expect(broadcastShape.parse({ status: "scheduled" })).toEqual({
      status: "scheduled",
      steps: 4,
      subject: true,
    })
  })

  test("seeding broadcast shape round-trips", () => {
    clearSeededShapes()
    seedShape(broadcastShape, "bc_1", broadcastSeed("scheduled"))
    expect(getSeededShape(broadcastShape, "bc_1")).toEqual(broadcastSeed("scheduled"))
    expect(getSeededShape(broadcastShape, "bc_unknown")).toEqual(
      broadcastShape.fallback,
    )
  })

  test("parse validates allowed status values", () => {
    expect(broadcastShape.parse({ status: "draft" })).toEqual(broadcastSeed("draft"))
    expect(broadcastShape.parse({ status: "canceled" })).toEqual(
      broadcastSeed("canceled"),
    )
    expect(broadcastShape.parse({ status: "not_a_status" })).toBeNull()
    expect(broadcastShape.parse(null)).toBeNull()
  })
})
