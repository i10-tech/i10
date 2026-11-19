import { describe, expect, test } from "bun:test"
import { encodeShape, parseShapes, shapeFromText } from "@/lib/shapes"
import { webhooksShape, type WebhooksData } from "@/lib/shapes/webhooks"
import { webhookDetailShape, type WebhookDetailData } from "@/lib/shapes/webhook-detail"
import {
  webhookDeliveryDetailShape,
  type WebhookDeliveryDetailData,
} from "@/lib/shapes/webhook-delivery-detail"
import {
  clearSeededShapes,
  getSeededShape,
  seedShape,
} from "@/components/list/remembered-shapes"
import type { DeliveryRow, WebhookDeliveryDetail, WebhookEndpoint } from "@/lib/types"

describe("webhooks page shapes", () => {
  describe("webhooksShape", () => {
    test("computes shape from data correctly", () => {
      const mockEndpoints = [
        {
          id: "ep-1",
          health: "disabled",
          enabled: true,
        },
        {
          id: "ep-2",
          health: "failing",
          enabled: true,
        },
      ] as WebhookEndpoint[]

      const data: WebhooksData = {
        endpoints: mockEndpoints,
        deliveries: Array.from({ length: 15 }, (_, i) => ({
          id: `d-${i}`,
        })) as DeliveryRow[],
        nextCursor: null,
        stats: null,
        catalog: [],
        tab: "endpoints",
        view: "grid",
      }

      const shape = webhooksShape.of(data)
      expect(shape.endpoints).toBe(2)
      expect(shape.banner).toBe("both")
      expect(shape.deliveries).toBe(10) // capped at MAX_SKELETON_ROWS=10
      expect(shape.view).toBe("grid")
      expect(shape.tab).toBe("endpoints")
    })

    test("round-trips through cookie parsing", () => {
      const shape = {
        endpoints: 2,
        view: "table" as const,
        banner: "disabled" as const,
        deliveries: 4,
        tab: "deliveries" as const,
      }
      const cookies = [
        { name: "i10-shape-webhooks", value: encodeShape("tenant-1", shape) },
      ]
      const text = parseShapes(cookies, "tenant-1").webhooks
      expect(shapeFromText(webhooksShape, text)).toEqual(shape)
      expect(parseShapes(cookies, "tenant-2")).toEqual({})
    })

    test("falls back on invalid or malformed text", () => {
      expect(shapeFromText(webhooksShape, "invalid")).toEqual(webhooksShape.fallback)
      expect(
        shapeFromText(webhooksShape, JSON.stringify({ endpoints: -5, deliveries: 0 })),
      ).toEqual(webhooksShape.fallback)
    })
  })

  describe("webhookDetailShape", () => {
    test("computes shape from endpoint data", () => {
      const endpoint = {
        id: "ep-1",
        kind: "http",
        health: "failing",
        enabled: true,
      } as WebhookEndpoint

      const data: WebhookDetailData = {
        endpoint,
        stats: null,
        dayStats: null,
        health: [{ id: "h-1" }] as never[],
        deliveries: [{ id: "d-1" }] as never[],
        nextCursor: null,
        replays: [],
        catalog: [],
        window: "24h",
        tab: "deliveries",
      }

      const shape = webhookDetailShape.of(data)
      expect(shape.kind).toBe("http")
      expect(shape.state).toBe("failing")
      expect(shape.notice).toBe("failing")
      expect(shape.tab).toBe("deliveries")
      expect(shape.health).toBe(1)
      expect(shape.deliveries).toBe(1)
      expect(shape.replays).toBe(0)
    })

    test("transformation tab only allowed for kind http", () => {
      const endpoint = {
        id: "ep-2",
        kind: "polling",
        health: "healthy",
        enabled: true,
      } as WebhookEndpoint

      const data: WebhookDetailData = {
        endpoint,
        stats: null,
        dayStats: null,
        health: [],
        deliveries: [],
        nextCursor: null,
        replays: [],
        catalog: [],
        window: "24h",
        tab: "transformation", // invalid for polling
      }

      const shape = webhookDetailShape.of(data)
      expect(shape.kind).toBe("polling")
      expect(shape.tab).toBe("overview") // falls back to overview
    })

    test("seeds and retrieves record shape", () => {
      clearSeededShapes()
      seedShape(webhookDetailShape, "ep-test", {
        kind: "sqs",
        tab: "overview",
        state: "healthy",
        notice: "none",
        deliveries: 3,
        replays: 0,
        health: 0,
        described: false,
        events: 0,
      })
      const retrieved = getSeededShape(webhookDetailShape, "ep-test")
      expect(retrieved.kind).toBe("sqs")
      expect(retrieved.state).toBe("healthy")
      expect(retrieved.deliveries).toBe(3)
    })
  })

  describe("webhookDeliveryDetailShape", () => {
    test("computes shape correctly with error and transform", () => {
      const delivery = {
        id: "del-1",
        status: "failed",
        last_error: "Connection refused",
        payload_expunged_at: null,
        transformed: { method: "POST", url: "https://example.com" },
      } as unknown as WebhookDeliveryDetail

      const data: WebhookDeliveryDetailData = {
        delivery,
        endpoint: { id: "ep-1", kind: "http" } as WebhookEndpoint,
      }

      const shape = webhookDeliveryDetailShape.of(data)
      expect(shape.status).toBe("failed")
      expect(shape.hasError).toBe(true)
      expect(shape.transformed).toBe(true)
      expect(shape.expunged).toBe(false)
      expect(shape.polling).toBe(false)
    })

    test("seeds and retrieves delivery record shape", () => {
      clearSeededShapes()
      seedShape(webhookDeliveryDetailShape, "del-100", {
        status: "pending",
        transformed: false,
        expunged: false,
        hasError: true,
        polling: false,
      })
      const retrieved = getSeededShape(webhookDeliveryDetailShape, "del-100")
      expect(retrieved.status).toBe("pending")
      expect(retrieved.hasError).toBe(true)
    })
  })
})
