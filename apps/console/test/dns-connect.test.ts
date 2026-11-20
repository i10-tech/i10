import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"

/**
 * ⚠ A DOMAIN THE CONNECTION COULD NOT PUBLISH USED TO READ AS PUBLISHED.
 * Connecting Cloudflare for a domain the account does not hold, the publish was
 * refused, the pipeline skipped it and reported "done", and the page ticked
 * "Publishing your records" and "Checking them" for records that were never
 * written - then waited on propagation for ever.
 */

mock.module("server-only", () => ({}))
const realActions = await import("@/lib/actions")

let pending: { id: string; name: string; zone: string | null }[]
let publishAnswer: { ok: true; data: { created: unknown[] } } | Record<string, unknown>
const published: string[] = []

mock.module("@/lib/actions", () => ({
  finishDnsConnect: () =>
    Promise.resolve({
      ok: true,
      data: { zones: ["example.com"], pending, return_to: null },
    }),
  publishDnsRecords: ({ domainId }: { domainId: string }) => {
    published.push(domainId)
    return Promise.resolve(publishAnswer)
  },
  verifyDomain: (id: string) =>
    Promise.resolve({ ok: true, data: { id, status: "pending", records: [] } }),
  verifyDomainQuietly: () => Promise.reject(new Error("unused")),
  refreshDomain: () => Promise.reject(new Error("unused")),
}))

const { runDnsConnect, PUBLISH_FAILED } = await import("@/lib/dns-connect")
const { progressRows } = await import("@/components/connect-progress")

afterAll(() => {
  mock.module("@/lib/actions", () => ({ ...realActions }))
})

beforeEach(() => {
  published.length = 0
  publishAnswer = { ok: true, data: { created: [{}] } }
})

async function connect() {
  const stages: string[] = []
  const outcome = await runDnsConnect({
    provider: "cloudflare",
    code: "code",
    state: "state",
    onDomain: (_, stage) => stages.push(stage.kind),
  })
  return { outcome, stages }
}

describe("finishing a DNS connection", () => {
  it("publishes nothing for a domain the connection cannot see, and says so first", async () => {
    pending = [{ id: "dom_1", name: "abdosworld.com", zone: null }]

    const { outcome, stages } = await connect()

    expect(published).toEqual([])
    expect(stages).toEqual(["unreachable"])
    expect(outcome.results).toEqual([
      {
        id: "dom_1",
        name: "abdosworld.com",
        stage: { kind: "unreachable", zones: ["example.com"] },
      },
    ])
  })

  it("carries the API's reason for a publish it refused", async () => {
    pending = [{ id: "dom_1", name: "mine.example.com", zone: "example.com" }]
    publishAnswer = {
      ok: false,
      status: 502,
      error: "cloudflare refused the change: quota",
    }

    const { outcome, stages } = await connect()

    expect(stages).toEqual(["publishing", "failed"])
    expect(outcome.results[0]?.stage).toEqual({
      kind: "failed",
      reason: "cloudflare refused the change: quota",
    })
  })

  it("falls back to the catch-all when the refusal says nothing", async () => {
    pending = [{ id: "dom_1", name: "mine.example.com", zone: "example.com" }]
    publishAnswer = { ok: false, status: 500, error: "" }

    const { outcome } = await connect()

    expect(outcome.results[0]?.stage).toEqual({
      kind: "failed",
      reason: PUBLISH_FAILED,
    })
  })

  it("reports each domain on its own", async () => {
    pending = [
      { id: "dom_1", name: "abdosworld.com", zone: null },
      { id: "dom_2", name: "mine.example.com", zone: "example.com" },
    ]

    const { outcome } = await connect()

    expect(published).toEqual(["dom_2"])
    expect(outcome.results.map((r) => [r.id, r.stage.kind])).toEqual([
      ["dom_1", "unreachable"],
      ["dom_2", "published"],
    ])
  })
})

describe("the progress card's lines", () => {
  const view = { name: "Cloudflare", phase: "done" as const }

  it("ticks nothing it did not do for a domain it could not publish", () => {
    const rows = progressRows(
      { ...view, stage: { kind: "unreachable", zones: [] } },
      false,
    )

    expect(rows.map((r) => `${r.key}:${r.state}`)).toEqual([
      "connecting:done",
      "publishing:halted",
    ])
  })

  it("does not tick the check when the check did not answer", () => {
    const rows = progressRows(
      { ...view, stage: { kind: "published", checked: false } },
      false,
    )

    expect(rows.map((r) => `${r.key}:${r.state}`)).toEqual([
      "connecting:done",
      "publishing:done",
      "propagating:current",
    ])
  })
})
