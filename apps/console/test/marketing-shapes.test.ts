import { broadcastSeed, broadcastShape } from "@/lib/shapes/broadcast"
import { describe, expect, test } from "bun:test"
import { encodeShape, parseShapes, shapeFromText } from "@/lib/shapes"
import { broadcastsShape } from "@/lib/shapes/broadcasts"
import { segmentsShape } from "@/lib/shapes/segments"
import { topicsShape } from "@/lib/shapes/topics"
import {
  clearSeededShapes,
  getSeededShape,
  seedShape,
} from "@/components/list/remembered-shapes"

describe("broadcastsShape", () => {
  const shape = {
    rows: 4,
    view: "grid" as const,
    statusFilter: true,
    segmentFilter: false,
  }

  test("round-trips through the cookie for its own workspace only", () => {
    const cookies = [{ name: "i10-shape-broadcasts", value: encodeShape("t1", shape) }]
    const text = parseShapes(cookies, "t1").broadcasts
    expect(shapeFromText(broadcastsShape, text)).toEqual(shape)
    expect(parseShapes(cookies, "t2")).toEqual({})
  })

  test("caps rows at MAX_SKELETON_ROWS (10)", () => {
    expect(
      shapeFromText(broadcastsShape, JSON.stringify({ ...shape, rows: 99 })).rows,
    ).toBe(10)
  })

  test("malformed falls back", () => {
    expect(shapeFromText(broadcastsShape, "{bad")).toEqual(broadcastsShape.fallback)
    expect(
      shapeFromText(broadcastsShape, JSON.stringify({ rows: -1, view: "table" })),
    ).toEqual(broadcastsShape.fallback)
    expect(
      shapeFromText(broadcastsShape, JSON.stringify({ rows: 2, view: "invalid" })),
    ).toEqual(broadcastsShape.fallback)
    expect(broadcastsShape.parse(null)).toBeNull()
    expect(broadcastsShape.parse("not-an-object")).toBeNull()
  })

  test("derives from data correctly with multiple items", () => {
    const derived = broadcastsShape.of({
      broadcasts: [
        {
          id: "b1",
          name: "First",
          status: "draft",
          segment_id: "s1",
          segment_name: "Seg 1",
          topic_id: null,
          from: "hello@domain.com",
          reply_to: [],
          subject: "Hi",
          preview_text: null,
          scheduled_at: null,
          sent_at: null,
          recipient_count: 10,
          created_at: "2026-01-01",
        },
        {
          id: "b2",
          name: "Second",
          status: "sent",
          segment_id: "s2",
          segment_name: "Seg 2",
          topic_id: null,
          from: "hello@domain.com",
          reply_to: [],
          subject: "Hello",
          preview_text: null,
          scheduled_at: null,
          sent_at: "2026-01-02",
          recipient_count: 20,
          created_at: "2026-01-02",
        },
      ],
      view: "grid",
    })
    expect(derived).toEqual({
      rows: 2,
      view: "grid",
      statusFilter: true,
      segmentFilter: true,
    })
  })

  test("derives from empty list", () => {
    const derived = broadcastsShape.of({ broadcasts: [] })
    expect(derived).toEqual({
      rows: 0,
      view: "table",
      statusFilter: false,
      segmentFilter: false,
    })
  })

  test("filters are false when single status and no segments", () => {
    const derived = broadcastsShape.of({
      broadcasts: [
        {
          id: "b1",
          name: "Draft 1",
          status: "draft",
          segment_id: null,
          segment_name: null,
          topic_id: null,
          from: "hello@domain.com",
          reply_to: [],
          subject: "Hi",
          preview_text: null,
          scheduled_at: null,
          sent_at: null,
          recipient_count: null,
          created_at: "2026-01-01",
        },
        {
          id: "b2",
          name: "Draft 2",
          status: "draft",
          segment_id: null,
          segment_name: null,
          topic_id: null,
          from: "hello@domain.com",
          reply_to: [],
          subject: "Hi 2",
          preview_text: null,
          scheduled_at: null,
          sent_at: null,
          recipient_count: null,
          created_at: "2026-01-02",
        },
      ],
    })
    expect(derived).toEqual({
      rows: 2,
      view: "table",
      statusFilter: false,
      segmentFilter: false,
    })
  })
})

describe("broadcast record seeding", () => {
  test("seeds and reads broadcast record shape", () => {
    clearSeededShapes()
    seedShape(broadcastShape, "b-123", broadcastSeed("sent"))
    expect(getSeededShape(broadcastShape, "b-123")).toEqual(broadcastSeed("sent"))
  })

  test("cold deep link returns fallback", () => {
    clearSeededShapes()
    expect(getSeededShape(broadcastShape, "b-unknown")).toEqual(broadcastSeed("draft"))
  })
})

describe("segmentsShape", () => {
  test("default view is grid", () => {
    expect(segmentsShape.fallback.view).toBe("grid")
  })

  test("round-trips through cookie", () => {
    const shape = { rows: 5, view: "table" as const }
    const cookies = [{ name: "i10-shape-segments", value: encodeShape("t1", shape) }]
    const text = parseShapes(cookies, "t1").segments
    expect(shapeFromText(segmentsShape, text)).toEqual(shape)
  })

  test("caps rows and handles fallback", () => {
    expect(
      shapeFromText(segmentsShape, JSON.stringify({ rows: 50, view: "grid" })).rows,
    ).toBe(10)
    expect(
      shapeFromText(segmentsShape, JSON.stringify({ rows: -1, view: "grid" })),
    ).toEqual(segmentsShape.fallback)
    expect(
      shapeFromText(segmentsShape, JSON.stringify({ rows: 3, view: "unrecognized" })),
    ).toEqual(segmentsShape.fallback)
    expect(segmentsShape.parse(null)).toBeNull()
  })

  test("derives from data correctly", () => {
    const derived = segmentsShape.of({
      segments: [
        {
          id: "s1",
          name: "Segment 1",
          description: "Desc",
          contact_count: 5,
          created_at: "2026-01-01",
        },
      ],
    })
    expect(derived).toEqual({ rows: 1, view: "grid" })
  })
})

describe("topicsShape", () => {
  test("default view is table", () => {
    expect(topicsShape.fallback.view).toBe("table")
  })

  test("round-trips through cookie", () => {
    const shape = { rows: 2, view: "grid" as const }
    const cookies = [{ name: "i10-shape-topics", value: encodeShape("t1", shape) }]
    const text = parseShapes(cookies, "t1").topics
    expect(shapeFromText(topicsShape, text)).toEqual(shape)
  })

  test("caps rows and handles fallback", () => {
    expect(
      shapeFromText(topicsShape, JSON.stringify({ rows: 50, view: "table" })).rows,
    ).toBe(10)
    expect(
      shapeFromText(topicsShape, JSON.stringify({ rows: -1, view: "table" })),
    ).toEqual(topicsShape.fallback)
    expect(
      shapeFromText(topicsShape, JSON.stringify({ rows: 3, view: "bad-view" })),
    ).toEqual(topicsShape.fallback)
    expect(topicsShape.parse(null)).toBeNull()
  })

  test("derives from data correctly", () => {
    const derived = topicsShape.of({
      topics: [
        {
          id: "t1",
          name: "Topic 1",
          description: "Desc",
          default_subscription: "opt_in",
          visibility: "public",
          subscriber_count: 10,
          created_at: "2026-01-01",
        },
      ],
      view: "grid",
    })
    expect(derived).toEqual({ rows: 1, view: "grid" })
  })
})
