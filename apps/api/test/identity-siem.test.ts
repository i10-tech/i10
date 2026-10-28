import { describe, expect, it } from "bun:test"
import {
  SIEM_BATCH,
  SIEM_EVERY_MS,
  SIEM_MAX_OBJECTS_PER_RUN,
  SIEM_RETRY_MS,
  objectKey,
  presentSiem,
  runSiemExport,
  siemSettingsSchema,
  testSiem,
  toJsonl,
} from "../src/identity/siem.js"
import { enqueueDueSiem, siemJobId } from "../src/queue/siem-queue.js"
import { log, TENANT } from "./identity-fakes.js"
import {
  SECRET,
  event,
  memoryBucket,
  memorySiem,
  signatureHolds,
} from "./identity-siem-fakes.js"

/**
 * The SIEM export (#345): the key layout, the cursor that moves only after the
 * bucket accepted the object, the schedule re-checked in the database, the
 * signing, and what the settings refuse.
 */

const deps = (
  w: ReturnType<typeof memorySiem>,
  bucket: ReturnType<typeof memoryBucket>,
  allowed = true,
) => ({
  store: w.store,
  fetch: bucket.fetch,
  allowed: async () => allowed,
  log,
  now: () => w.clock.now,
})

describe("a run", () => {
  it("writes the new events as one object, named for its ids, and moves the cursor", async () => {
    const events = [event(1), event(2), event(3)]
    const w = memorySiem(TENANT, events)
    const bucket = memoryBucket()
    expect(await runSiemExport(deps(w, bucket), TENANT)).toEqual({
      outcome: "exported",
      objects: 1,
      events: 3,
    })
    expect(bucket.puts).toHaveLength(1)
    const put = bucket.puts[0]!
    expect(put.url).toBe(
      `https://s3.eu-west-1.amazonaws.com/acme-siem/logs/i10-identity/2026/10/28/${events[0]!.id}-${events[2]!.id}.jsonl`,
    )
    const lines = put.body.trimEnd().split("\n")
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      id: events[0]!.id,
      type: "sign_in.succeeded",
      subject_user_id: "user_ada",
      data: { n: 1 },
      created_at: events[0]!.createdAt.toISOString(),
    })
    expect(w.state.cursor).toBe(events[2]!.id)
    expect(w.state.nextRunAt.getTime()).toBe(w.clock.now.getTime() + SIEM_EVERY_MS)
  })

  it("signs the request so S3 would accept it", async () => {
    const w = memorySiem(TENANT, [event(1)])
    const bucket = memoryBucket()
    await runSiemExport(deps(w, bucket), TENANT)
    const put = bucket.puts[0]!
    expect(put.headers.authorization).toContain(
      "Credential=AKIAIOSFODNN7EXAMPLE/20261028/eu-west-1/s3/aws4_request",
    )
    expect(signatureHolds(put, SECRET)).toBe(true)
    // And a different secret does not verify: the check is not vacuous.
    expect(signatureHolds(put, `${SECRET}x`)).toBe(false)
  })

  it("carries on from the cursor and writes nothing when there is nothing new", async () => {
    const events = [event(1), event(2)]
    const w = memorySiem(TENANT, events)
    const bucket = memoryBucket()
    await runSiemExport(deps(w, bucket), TENANT)
    w.clock.now = new Date(w.clock.now.getTime() + SIEM_EVERY_MS + 1)
    events.push(event(3))
    await runSiemExport(deps(w, bucket), TENANT)
    expect(bucket.puts).toHaveLength(2)
    expect(bucket.puts[1]!.body.trimEnd().split("\n")).toHaveLength(1)
    w.clock.now = new Date(w.clock.now.getTime() + SIEM_EVERY_MS + 1)
    await runSiemExport(deps(w, bucket), TENANT)
    expect(bucket.puts).toHaveLength(2)
  })

  it("leaves the cursor where it was when the bucket refuses, and retries sooner than the hour", async () => {
    const w = memorySiem(TENANT, [event(1), event(2)])
    const bucket = memoryBucket(() => ({
      status: 403,
      body: "<Error><Code>AccessDenied</Code><Message>secret details</Message></Error>",
    }))
    const outcome = await runSiemExport(deps(w, bucket), TENANT)
    expect(outcome).toEqual({
      outcome: "failed",
      error: "The bucket answered 403 AccessDenied.",
    })
    expect(w.state.cursor).toBeNull()
    expect(w.state.lastError).toBe("The bucket answered 403 AccessDenied.")
    expect(w.state.lastError).not.toContain("secret details")
    expect(w.state.nextRunAt.getTime()).toBe(w.clock.now.getTime() + SIEM_RETRY_MS)
  })

  it("keeps what an earlier object achieved when a later one fails", async () => {
    const events = Array.from({ length: SIEM_BATCH + 1 }, (_, i) => event(i + 1))
    const w = memorySiem(TENANT, events)
    let calls = 0
    const bucket = memoryBucket(() =>
      ++calls === 1 ? { status: 200 } : { status: 500 },
    )
    const outcome = await runSiemExport(deps(w, bucket), TENANT)
    expect(outcome.outcome).toBe("failed")
    expect(w.state.cursor).toBe(events[SIEM_BATCH - 1]!.id)
  })

  it("never puts the secret in an error, whatever the endpoint does", async () => {
    const w = memorySiem(TENANT, [event(1)])
    const bucket = memoryBucket(() => ({ status: 400, body: `bad ${SECRET}` }))
    await runSiemExport(deps(w, bucket), TENANT)
    expect(w.state.lastError).not.toContain(SECRET)
  })

  it("is not due twice: a second run inside the schedule does nothing", async () => {
    const w = memorySiem(TENANT, [event(1)])
    const bucket = memoryBucket()
    await runSiemExport(deps(w, bucket), TENANT)
    expect(await runSiemExport(deps(w, bucket), TENANT)).toEqual({ outcome: "not_due" })
    expect(bucket.puts).toHaveLength(1)
  })

  it("does nothing for an export that is switched off", async () => {
    const w = memorySiem(TENANT, [event(1)], { enabled: false })
    const bucket = memoryBucket()
    expect(await runSiemExport(deps(w, bucket), TENANT)).toEqual({ outcome: "not_due" })
    expect(bucket.puts).toEqual([])
  })

  it("refuses a plan without the flag, writing nothing", async () => {
    const w = memorySiem(TENANT, [event(1)])
    const bucket = memoryBucket()
    expect(await runSiemExport(deps(w, bucket, false), TENANT)).toEqual({
      outcome: "plan_required",
    })
    expect(bucket.puts).toEqual([])
    expect(w.state.cursor).toBeNull()
  })

  it("comes back at the next tick when more is waiting than one run writes", async () => {
    const events = Array.from(
      { length: SIEM_BATCH * SIEM_MAX_OBJECTS_PER_RUN + 1 },
      (_, i) => event(i + 1),
    )
    const w = memorySiem(TENANT, events)
    const bucket = memoryBucket()
    const outcome = await runSiemExport(deps(w, bucket), TENANT)
    expect(outcome).toMatchObject({ objects: SIEM_MAX_OBJECTS_PER_RUN })
    expect(w.state.nextRunAt.getTime()).toBe(w.clock.now.getTime())
  })
})

describe("the test object", () => {
  const target = {
    endpoint: "https://s3.eu-west-1.amazonaws.com",
    bucket: "acme-siem",
    region: "eu-west-1",
    prefix: "logs",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: SECRET,
  }

  it("writes one small object under the prefix", async () => {
    const bucket = memoryBucket()
    const result = await testSiem(
      { fetch: bucket.fetch, now: () => new Date("2026-10-28T12:00:00Z") },
      target,
    )
    expect(result.ok).toBe(true)
    expect(bucket.puts).toHaveLength(1)
    expect(bucket.puts[0]!.url).toContain(
      "/acme-siem/logs/i10-identity/connection-test-",
    )
    expect(bucket.puts[0]!.body.length).toBeLessThan(100)
    expect(signatureHolds(bucket.puts[0]!, SECRET)).toBe(true)
  })

  it("reports the refusal in the bucket's words, not ours", async () => {
    const bucket = memoryBucket(() => ({
      status: 403,
      body: "<Error><Code>SignatureDoesNotMatch</Code></Error>",
    }))
    expect(await testSiem({ fetch: bucket.fetch }, target)).toEqual({
      ok: false,
      error: "The bucket answered 403 SignatureDoesNotMatch.",
    })
  })

  it("reports an endpoint the egress guard refuses", async () => {
    const result = await testSiem(
      {
        fetch: async () => {
          throw new Error("10.0.0.5 is not a public address")
        },
      },
      target,
    )
    expect(result).toEqual({ ok: false, error: "10.0.0.5 is not a public address" })
  })
})

describe("the key and the lines", () => {
  it("lays the key out by the last event's day, with no empty prefix segment", () => {
    expect(objectKey("", new Date("2026-01-05T23:59:59Z"), "a", "b")).toBe(
      "i10-identity/2026/01/05/a-b.jsonl",
    )
    expect(objectKey("x/y", new Date("2026-10-28T00:00:00Z"), "a", "b")).toBe(
      "x/y/i10-identity/2026/10/28/a-b.jsonl",
    )
  })

  it("names only the audit log's own fields", () => {
    const line = JSON.parse(
      toJsonl([event(1, { data: { ok: true } })]).trimEnd(),
    ) as Record<string, unknown>
    expect(Object.keys(line).sort()).toEqual([
      "actor_user_id",
      "connection_id",
      "created_at",
      "data",
      "id",
      "reason",
      "session_id",
      "subject_user_id",
      "type",
    ])
  })
})

describe("the settings", () => {
  const good = {
    endpoint: "https://s3.eu-west-1.amazonaws.com",
    bucket: "acme-siem",
    region: "eu-west-1",
    prefix: "logs/prod",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: SECRET,
  }

  it("accepts a sound set", () => {
    expect(siemSettingsSchema.safeParse(good).success).toBe(true)
  })

  it.each([
    ["an http endpoint", { endpoint: "http://s3.example.com" }],
    ["credentials in the endpoint", { endpoint: "https://u:p@s3.example.com" }],
    ["a path on the endpoint", { endpoint: "https://s3.example.com/bucket" }],
    ["a query on the endpoint", { endpoint: "https://s3.example.com/?x=1" }],
    ["an upper-case bucket", { bucket: "Acme" }],
    ["a bucket with a slash", { bucket: "a/b" }],
    ["a prefix climbing out", { prefix: "../other" }],
    ["a prefix with a leading slash", { prefix: "/logs" }],
    ["a prefix with a doubled slash", { prefix: "a//b" }],
    ["a key id with lower case", { accessKeyId: "akia1234567890123456" }],
    ["a secret with a space", { secretAccessKey: "abcd efgh abcd efgh abcd" }],
    ["a field we do not know", { surprise: true }],
  ])("refuses %s", (_name, over) => {
    expect(siemSettingsSchema.safeParse({ ...good, ...over }).success).toBe(false)
  })

  it("shows the secret as a hint only", () => {
    const w = memorySiem(TENANT, [])
    return w.store.get(TENANT).then((row) => {
      const shown = JSON.stringify(presentSiem(row!))
      expect(shown).not.toContain(SECRET)
      expect(shown).toContain(`••••${SECRET.slice(-4)}`)
    })
  })
})

describe("the scheduler", () => {
  it("offers each due workspace once a minute, across replicas, with one group each", async () => {
    const added: string[] = []
    const ids = ["t1", "t2"]
    const total = await enqueueDueSiem({
      due: async (after) => (after === null ? ids : []),
      enqueue: async (tenantId, nowMs) => void added.push(siemJobId(tenantId, nowMs!)),
      log: { error: () => {} },
      now: () => 120_000,
    })
    expect(total).toBe(2)
    expect(added).toEqual(["siem:t1:2", "siem:t2:2"])
    // Another replica a few seconds later computes the same ids.
    expect(siemJobId("t1", 125_000)).toBe("siem:t1:2")
  })
})
