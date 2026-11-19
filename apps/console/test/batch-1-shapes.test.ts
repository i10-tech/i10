import { describe, expect, test } from "bun:test"
import { encodeShape, parseShapes, shapeFromText } from "@/lib/shapes"
import { getSeededShape, seedShape } from "@/components/list/remembered-shapes"
import { apiKeysShape } from "@/lib/shapes/api-keys"
import { contactsShape } from "@/lib/shapes/contacts"
import { logsShape } from "@/lib/shapes/logs"
import { suppressionsShape } from "@/lib/shapes/suppressions"
import { emailsShape } from "@/lib/shapes/emails"
import { emailShape, emailShapeFromRow } from "@/lib/shapes/email"
import type {
  ApiKeyRow,
  ContactRow,
  DomainSummary,
  EmailRow,
  RequestRow,
  SegmentRow,
  SuppressionRow,
} from "@/lib/types"

describe("Batch 1 shapes", () => {
  describe("api-keys shape", () => {
    test("calculates shape with capped rows", () => {
      const keys = Array.from({ length: 15 }, (_, i) => ({ id: `k-${i}` }) as ApiKeyRow)
      const shape = apiKeysShape.of({ keys, domains: [] })
      expect(shape).toEqual({ rows: 10 })
    })

    test("round-trips through cookie serialization", () => {
      const shape = { rows: 4 }
      const cookies = [{ name: "i10-shape-api-keys", value: encodeShape("t1", shape) }]
      const text = parseShapes(cookies, "t1")["api-keys"]
      expect(shapeFromText(apiKeysShape, text)).toEqual(shape)
      expect(parseShapes(cookies, "other-tenant")).toEqual({})
    })

    test("falls back on invalid or out-of-range value", () => {
      expect(shapeFromText(apiKeysShape, "{invalid")).toEqual(apiKeysShape.fallback)
      expect(shapeFromText(apiKeysShape, JSON.stringify({ rows: -2 }))).toEqual(
        apiKeysShape.fallback,
      )
      expect(shapeFromText(apiKeysShape, JSON.stringify({ rows: 50 })).rows).toBe(10)
    })
  })

  describe("contacts shape", () => {
    test("calculates shape with capped rows and segments", () => {
      const contacts = Array.from(
        { length: 20 },
        (_, i) => ({ id: `c-${i}` }) as ContactRow,
      )
      const segments = Array.from(
        { length: 15 },
        (_, i) => ({ id: `s-${i}` }) as SegmentRow,
      )
      const shape = contactsShape.of({ contacts, nextCursor: null, segments })
      expect(shape).toEqual({ rows: 10, segments: 10, hasMore: false })
    })

    test("round-trips through cookie serialization", () => {
      const shape = { rows: 3, segments: 2, hasMore: false }
      const cookies = [{ name: "i10-shape-contacts", value: encodeShape("t1", shape) }]
      const text = parseShapes(cookies, "t1")["contacts"]
      expect(shapeFromText(contactsShape, text)).toEqual(shape)
    })

    test("falls back on invalid value", () => {
      expect(shapeFromText(contactsShape, "{invalid")).toEqual(contactsShape.fallback)
      expect(
        shapeFromText(contactsShape, JSON.stringify({ rows: 3, segments: -1 })),
      ).toEqual(contactsShape.fallback)
    })
  })

  describe("logs shape", () => {
    test("calculates shape with capped rows and keys", () => {
      const rows = Array.from(
        { length: 12 },
        (_, i) => ({ id: `r-${i}` }) as RequestRow,
      )
      const apiKeys = Array.from({ length: 14 }, (_, i) => ({
        id: `k-${i}`,
        name: `Key ${i}`,
      }))
      const shape = logsShape.of({ rows, nextCursor: null, apiKeys })
      expect(shape).toEqual({ rows: 10, keys: 10, hasMore: false })
    })

    test("round-trips through cookie serialization", () => {
      const shape = { rows: 6, keys: 1, hasMore: false }
      const cookies = [{ name: "i10-shape-logs", value: encodeShape("t1", shape) }]
      const text = parseShapes(cookies, "t1")["logs"]
      expect(shapeFromText(logsShape, text)).toEqual(shape)
    })

    test("falls back on invalid value", () => {
      expect(shapeFromText(logsShape, "{invalid")).toEqual(logsShape.fallback)
      expect(
        shapeFromText(logsShape, JSON.stringify({ rows: "not-a-number" })),
      ).toEqual(logsShape.fallback)
    })
  })

  describe("suppressions shape", () => {
    test("calculates shape with capped rows", () => {
      const rows = Array.from(
        { length: 16 },
        (_, i) => ({ address: `a${i}@ex.com` }) as unknown as SuppressionRow,
      )
      const shape = suppressionsShape.of({ rows, nextCursor: null })
      expect(shape).toEqual({ rows: 10, hasMore: false })
    })

    test("round-trips through cookie serialization", () => {
      const shape = { rows: 2, hasMore: false }
      const cookies = [
        { name: "i10-shape-suppressions", value: encodeShape("t1", shape) },
      ]
      const text = parseShapes(cookies, "t1")["suppressions"]
      expect(shapeFromText(suppressionsShape, text)).toEqual(shape)
    })

    test("falls back on invalid value", () => {
      expect(shapeFromText(suppressionsShape, "{invalid")).toEqual(
        suppressionsShape.fallback,
      )
    })
  })

  describe("emails shape", () => {
    test("calculates shape with rows and hasMore flag", () => {
      const rows = Array.from({ length: 5 }, (_, i) => ({ id: `e-${i}` }) as EmailRow)
      expect(
        emailsShape.of({ rows, nextCursor: "cur-1", domains: [], apiKeys: [] }),
      ).toEqual({
        rows: 5,
        hasMore: true,
        domainFilter: false,
        keyFilter: false,
      })
      expect(
        emailsShape.of({ rows, nextCursor: null, domains: [], apiKeys: [] }),
      ).toEqual({
        rows: 5,
        hasMore: false,
        domainFilter: false,
        keyFilter: false,
      })
    })

    test("the filters show from the domains and keys the data has", () => {
      const only = { rows: [], nextCursor: null }
      const domain = { id: "d" } as DomainSummary
      const key = { id: "k" } as ApiKeyRow
      expect(
        emailsShape.of({ ...only, domains: [domain], apiKeys: [] }).domainFilter,
      ).toBe(false)
      expect(
        emailsShape.of({ ...only, domains: [domain, domain], apiKeys: [] })
          .domainFilter,
      ).toBe(true)
      expect(emailsShape.of({ ...only, domains: [], apiKeys: [key] }).keyFilter).toBe(
        true,
      )
    })

    test("round-trips through cookie serialization", () => {
      const shape = { rows: 7, hasMore: true, domainFilter: true, keyFilter: true }
      const cookies = [{ name: "i10-shape-emails", value: encodeShape("t1", shape) }]
      const text = parseShapes(cookies, "t1")["emails"]
      expect(shapeFromText(emailsShape, text)).toEqual(shape)
    })

    test("falls back on invalid value", () => {
      expect(shapeFromText(emailsShape, "{invalid")).toEqual(emailsShape.fallback)
    })
  })

  describe("email record seeding", () => {
    test("derives seed shape from an email row", () => {
      const row: EmailRow = {
        id: "msg_123",
        created_at: "2026-11-05T00:00:00Z",
        from: "sender@example.com",
        to: ["r1@example.com", "r2@example.com"],
        subject: "Hello",
        status: "delivered",
        last_event: "delivered",
        scheduled_at: null,
        sent_at: "2026-11-05T00:00:01Z",
        last_error: null,
      }
      const seed = emailShapeFromRow(row)
      expect(seed).toEqual({
        to: 2,
        cc: 0,
        bcc: 0,
        replyTo: 0,
        attachments: 0,
        steps: 3,
        error: false,
        tags: 0,
        broadcast: false,
        scheduled: false,
        sent: true,
        attempts: 1,
        log: 3,
        provider: true,
      })
    })

    test("can seed and read back a record shape", () => {
      const row: EmailRow = {
        id: "msg_456",
        created_at: "2026-11-05T00:00:00Z",
        from: "sender@example.com",
        to: ["r1@example.com"],
        subject: "Problem",
        status: "failed",
        last_event: "bounced",
        scheduled_at: null,
        sent_at: null,
        last_error: "550 User unknown",
      }
      seedShape(emailShape, row.id, emailShapeFromRow(row))
      const retrieved = getSeededShape(emailShape, row.id)
      expect(retrieved.to).toBe(1)
      expect(retrieved.error).toBe(true)
      expect(retrieved.sent).toBe(false)
    })
  })
})
