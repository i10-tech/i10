import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { defineShape } from "@/lib/shapes"
import {
  clearSeededShapes,
  getSeededShape,
  seedShape,
} from "@/components/list/remembered-shapes"

class MockStorage implements Storage {
  private map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  clear() {
    this.map.clear()
  }
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value))
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null
  }
}

if (typeof globalThis.sessionStorage === "undefined") {
  globalThis.sessionStorage = new MockStorage()
}

interface TestShape {
  tab: string
  rows: number
}

const testDef = defineShape<TestShape, TestShape>({
  page: "test-record",
  fallback: { tab: "overview", rows: 0 },
  of: (d) => d,
  parse: (raw) => {
    if (typeof raw === "object" && raw !== null && "tab" in raw && "rows" in raw) {
      const r = raw as TestShape
      return { tab: String(r.tab), rows: Number(r.rows) }
    }
    return null
  },
})

describe("record shape seeding", () => {
  beforeEach(() => {
    clearSeededShapes()
    sessionStorage.clear()
  })

  afterEach(() => {
    clearSeededShapes()
    sessionStorage.clear()
  })

  test("seeded shape is returned for matching id", () => {
    seedShape(testDef, "rec-1", { tab: "deliveries", rows: 4 })
    const shape = getSeededShape(testDef, "rec-1")
    expect(shape).toEqual({ tab: "deliveries", rows: 4 })
  })

  test("cold deep link falls back to default shape", () => {
    const shape = getSeededShape(testDef, "rec-unseeded")
    expect(shape).toEqual(testDef.fallback)
  })

  test("recovers from sessionStorage if in-memory map is empty", () => {
    seedShape(testDef, "rec-2", { tab: "settings", rows: 2 })
    clearSeededShapes()
    // In-memory map is now cleared, but sessionStorage holds the mirrored value
    const shape = getSeededShape(testDef, "rec-2")
    expect(shape).toEqual({ tab: "settings", rows: 2 })
  })

  test("malformed storage entry falls back", () => {
    sessionStorage.setItem("i10-seed-test-record-bad", "invalid-json")
    const shape = getSeededShape(testDef, "bad")
    expect(shape).toEqual(testDef.fallback)
  })
})
