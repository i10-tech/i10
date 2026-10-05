import { describe, expect, test } from "bun:test"
import { renderWebhookHealth } from "@repo/emails"
import { webhookEventData, webhookPayloadSchema } from "@repo/contracts"
import { exampleData } from "../src/webhooks/examples.js"
import { formatWhen } from "../src/webhooks/health-notice.js"
import {
  FAILING_AFTER_SECONDS,
  summarize,
  type HealthEventRow,
  type HealthKind,
} from "../src/webhooks/health.js"
import { RULES } from "../src/webhooks/schedule.js"

let n = 0
const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 10, minute))
const ev = (endpointId: string, kind: HealthKind, minute: number): HealthEventRow => ({
  id: `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`,
  endpointId,
  kind,
  url: `https://${endpointId}.example.com/hook`,
  reason: kind === "recovered" ? null : kind === "disabled" ? "Gone." : "HTTP 503",
  failingSince: kind === "recovered" ? null : at(minute - 15),
  occurredAt: at(minute),
})

describe("summarize", () => {
  test("one line per endpoint, in its latest state, worst first", () => {
    const events = [
      ev("a", "failing", 1),
      ev("b", "failing", 2),
      ev("a", "disabled", 5),
      ev("c", "recovered", 3),
    ]
    const { summary, emailed, suppressed } = summarize(events)
    expect(summary!.worst).toBe("disabled")
    expect(summary!.lines.map((l) => [l.endpointId, l.state])).toEqual([
      ["a", "disabled"],
      ["b", "failing"],
      ["c", "recovered"],
    ])
    expect(emailed).toHaveLength(4)
    expect(suppressed).toEqual([])
  })

  test("a failure that recovered before anyone was told is dropped", () => {
    const blip = [ev("a", "failing", 1), ev("a", "recovered", 2)]
    const { summary, emailed, suppressed } = summarize(blip)
    expect(summary).toBeNull()
    expect(emailed).toEqual([])
    expect(suppressed).toEqual(blip.map((e) => e.id))
  })

  test("but never one that was switched off on the way", () => {
    const { summary } = summarize([
      ev("a", "failing", 1),
      ev("a", "disabled", 2),
      ev("a", "recovered", 3),
    ])
    expect(summary!.lines).toHaveLength(1)
    expect(summary!.lines[0]!.state).toBe("recovered")
  })

  test("a recovery the owner was told about the failure of is sent", () => {
    // The failing email already went; only the recovery waits.
    const { summary } = summarize([ev("a", "recovered", 9)])
    expect(summary!.worst).toBe("recovered")
  })

  test("order of arrival does not matter, the clock does", () => {
    const events = [ev("a", "recovered", 9), ev("a", "failing", 1)]
    expect(summarize(events).summary).toBeNull()
  })

  test("a failing line dates from when the failures began", () => {
    const { summary } = summarize([ev("a", "failing", 20)])
    expect(summary!.lines[0]!.since).toEqual(at(5))
  })
})

describe("the failing threshold", () => {
  test("comes before every plan's retry window ends", () => {
    // So an owner hears an endpoint is failing before any event to it is
    // given up on - the reason exhaustion is not a separate trigger.
    for (const policy of ["free", "pro", "scale", "enterprise"] as const) {
      const window = RULES.policies[policy].gaps.reduce((a, b) => a + b, 0)
      expect(FAILING_AFTER_SECONDS).toBeLessThan(window)
    }
  })
})

describe("the email", () => {
  const line = (state: HealthKind) => ({
    url: "https://api.acme.com/hook",
    state,
    reason: state === "recovered" ? null : "HTTP 503",
    since: formatWhen(at(40)),
  })

  test("names the worst state, and counts when there are several", async () => {
    const one = await renderWebhookHealth({
      workspace: "Acme",
      worst: "disabled",
      lines: [line("disabled")],
      url: "https://console.i10.tech/webhooks",
    })
    expect(one.subject).toBe("A webhook endpoint for Acme was switched off")
    expect(one.text).toContain("switch the endpoint back on")

    const two = await renderWebhookHealth({
      workspace: "Acme",
      worst: "failing",
      lines: [line("failing"), line("recovered")],
      url: "https://console.i10.tech/webhooks",
    })
    expect(two.subject).toBe("2 webhook endpoints for Acme need attention")
    expect(two.text).toContain("nothing is lost yet")
    expect(two.text).toContain("Last error: HTTP 503")

    const back = await renderWebhookHealth({
      workspace: "Acme",
      worst: "recovered",
      lines: [line("recovered")],
      url: "https://console.i10.tech/webhooks",
    })
    expect(back.subject).toBe("A webhook endpoint for Acme has recovered")
  })

  test("times are UTC and unambiguous", () => {
    expect(formatWhen(at(40))).toBe("6 October 2026, 10:40 UTC")
  })
})

describe("webhook_endpoint.* payloads", () => {
  for (const type of [
    "webhook_endpoint.failing",
    "webhook_endpoint.disabled",
    "webhook_endpoint.recovered",
  ] as const) {
    test(`${type}: the example is strict and carries no email fields`, () => {
      const data = exampleData(type, at(0))
      expect(webhookEventData[type].safeParse(data).success).toBe(true)
      expect(data).not.toHaveProperty("email_id")
      expect(
        webhookPayloadSchema(type).safeParse({
          id: "00000000-0000-7000-8000-000000000000",
          type,
          created_at: at(0).toISOString(),
          data,
        }).success,
      ).toBe(true)
    })
  }
})
