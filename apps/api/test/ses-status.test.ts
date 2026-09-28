import { createSign, generateKeyPairSync } from "node:crypto"
import { describe, expect, it, mock } from "bun:test"
import type { SendEmail } from "@repo/contracts"
import { createSesWebhooks } from "../src/routes/ses-events.js"
import { acceptSend, type AcceptOps } from "../src/send/accept.js"
import { unmetered, type Metering } from "../src/send/metering.js"
import {
  parseTenantStatusEvent,
  type TenantStatusEvent,
} from "../src/ses-status/event.js"
import { pollTenantStatuses, type TenantStatusReader } from "../src/ses-status/poll.js"
import { sesStatusService, type OwnerNotice } from "../src/ses-status/service.js"
import type { SesStatusStore } from "../src/ses-status/store.js"
import { canonicalString, type SnsMessage } from "../src/webhooks/sns.js"

/**
 * SES tenant sending status (#157).
 *
 * ⚠ THE FAILURES WORTH GUARDING ARE THE SILENT ONES. A status event parsed as
 * nothing is a pause we never enforce; a pause not refused at accept is mail
 * that answers 200 and then sits deferred until it gives up; an owner emailed
 * on every poll is a notice they learn to ignore.
 */

const WORKSPACE = "0190a3e4-5b6c-7d8e-9f00-112233445566"
const TENANT_ARN = `arn:aws:ses:eu-central-1:699073937874:tenant/i10-${WORKSPACE}/tn-abc`

/** The status-change example from the SES tenants guide, pointed at our tenant. */
const disabledEvent = (over: Record<string, unknown> = {}) => ({
  "detail-type": "Sending Status Disabled",
  source: "aws.ses",
  account: "699073937874",
  time: "2025-07-24T12:44:28Z",
  region: "eu-central-1",
  resources: [TENANT_ARN],
  detail: {
    version: "1.0.0",
    data: {
      origin: "AWS_MANAGED",
      record: {
        status: "DISABLED",
        cause: "High bounce rate.",
        lastUpdatedTimestamp: [2025, 7, 24, 12, 44, 28, 995000000],
      },
    },
  },
  ...over,
})

describe("parseTenantStatusEvent", () => {
  it("reads the tenant, status, origin, cause and SES's array timestamp", () => {
    expect(parseTenantStatusEvent(disabledEvent())).toEqual({
      sesTenant: `i10-${WORKSPACE}`,
      status: "disabled",
      cause: "High bounce rate.",
      origin: "aws_managed",
      changedAt: new Date("2025-07-24T12:44:28.995Z"),
    })
  })

  // ⚠ The detail-type can only say Enabled; the record says Reinstated.
  it("keeps reinstated distinct from enabled", () => {
    const event = disabledEvent({ "detail-type": "Sending Status Enabled" })
    ;(event.detail.data.record as { status: string }).status = "REINSTATED"
    expect(parseTenantStatusEvent(event)?.status).toBe("reinstated")
  })

  it("ignores reputation findings, which are #158's", () => {
    expect(
      parseTenantStatusEvent({
        ...disabledEvent(),
        "detail-type": "Advisor Recommendation Status Open",
      }),
    ).toBeNull()
  })

  it("ignores anything that is not an SES EventBridge event", () => {
    expect(parseTenantStatusEvent({ eventType: "Bounce", mail: {} })).toBeNull()
    expect(parseTenantStatusEvent({ ...disabledEvent(), source: "aws.s3" })).toBeNull()
  })
})

/** A store that remembers one current status and every recorded change. */
const memoryStore = (initial: "enabled" | "disabled" | "reinstated" | null = null) => {
  let current: { status: string; changedAt: Date } | null = initial
    ? { status: initial, changedAt: new Date(0) }
    : null
  const recorded: unknown[] = []
  const store: SesStatusStore = {
    record: mock(async (change) => {
      recorded.push(change)
      const previous = (current?.status ?? "enabled") as "enabled"
      if (current && current.changedAt >= change.changedAt)
        return { changed: false, previous }
      if (!current && change.status === "enabled") return { changed: false, previous }
      current = { status: change.status, changedAt: change.changedAt }
      return { changed: previous !== change.status, previous }
    }),
    current: mock(async () =>
      current
        ? {
            status: current.status as "enabled",
            cause: null,
            origin: null,
            changedAt: current.changedAt,
            notifiedAt: null,
          }
        : null,
    ),
    markNotified: mock(async () => {}),
  }
  return { store, recorded }
}

const event = (over: Partial<TenantStatusEvent> = {}): TenantStatusEvent => ({
  sesTenant: `i10-${WORKSPACE}`,
  status: "disabled",
  cause: "High bounce rate.",
  origin: "aws_managed",
  changedAt: new Date("2026-09-28T10:00:00Z"),
  ...over,
})

describe("sesStatusService", () => {
  it("records a pause and emails the owner once", async () => {
    const { store } = memoryStore()
    const notice: OwnerNotice = { send: mock(async () => {}) }
    const service = sesStatusService({ store, notice })

    expect(await service.apply(event(), "event")).toBe("changed")
    expect(notice.send).toHaveBeenCalledWith({
      tenantId: WORKSPACE,
      paused: true,
      cause: "High bounce rate.",
      key: `ses-status:${WORKSPACE}:disabled:2026-09-28T10:00:00.000Z`,
    })
    expect(store.markNotified).toHaveBeenCalled()

    // The same change again - SNS redelivery, or the poll - tells nobody twice.
    expect(await service.apply(event(), "poll")).toBe("unchanged")
    expect(notice.send).toHaveBeenCalledTimes(1)
  })

  it("emails the owner when a pause is lifted", async () => {
    const { store } = memoryStore("disabled")
    const notice: OwnerNotice = { send: mock(async () => {}) }

    await sesStatusService({ store, notice }).apply(
      event({ status: "reinstated" }),
      "event",
    )
    expect(notice.send).toHaveBeenCalledWith(expect.objectContaining({ paused: false }))
  })

  it("says nothing for a move that does not cross the paused line", async () => {
    const { store } = memoryStore("reinstated")
    const notice: OwnerNotice = { send: mock(async () => {}) }

    expect(
      await sesStatusService({ store, notice }).apply(
        event({ status: "enabled" }),
        "event",
      ),
    ).toBe("changed")
    expect(notice.send).not.toHaveBeenCalled()
  })

  it("keeps the pause when the email fails", async () => {
    const { store } = memoryStore()
    const log = { error: mock() }
    const notice: OwnerNotice = {
      send: mock(async () => {
        throw new Error("clerk is down")
      }),
    }

    expect(await sesStatusService({ store, notice, log }).apply(event(), "event")).toBe(
      "changed",
    )
    expect(log.error).toHaveBeenCalled()
    expect(store.markNotified).not.toHaveBeenCalled()
  })

  // ⚠ Our own tenant paused means sign-in codes stop: wake a human.
  it("alerts, and stores nothing, when our own tenant is paused", async () => {
    const { store } = memoryStore()
    const alert = mock()

    expect(
      await sesStatusService({ store, alert }).apply(
        event({ sesTenant: "i10-internal" }),
        "event",
      ),
    ).toBe("system")
    expect(alert).toHaveBeenCalled()
    expect(store.record).not.toHaveBeenCalled()
  })

  it("ignores a tenant that is not ours", async () => {
    const { store } = memoryStore()
    expect(
      await sesStatusService({ store }).apply(
        event({ sesTenant: "made-by-hand" }),
        "event",
      ),
    ).toBe("ignored")
    expect(store.record).not.toHaveBeenCalled()
  })

  it("ignores a workspace that has since been deleted", async () => {
    const { store } = memoryStore()
    store.record = mock(async () => {
      throw Object.assign(new Error("fk"), { code: "23503" })
    })
    expect(await sesStatusService({ store }).apply(event(), "event")).toBe("ignored")
  })
})

describe("pollTenantStatuses", () => {
  const reader = (statuses: Record<string, "enabled" | "disabled" | "reinstated">) =>
    ({
      tenants: async () => Object.keys(statuses),
      status: async (t: string) => statuses[t] ?? null,
    }) satisfies TenantStatusReader

  it("reports only a status that differs from what we hold", async () => {
    const { store } = memoryStore()
    const service = { apply: mock(async () => "changed" as const) }
    const other = "0190a3e4-0000-7000-8000-000000000002"

    const summary = await pollTenantStatuses({
      reader: reader({ [`i10-${WORKSPACE}`]: "disabled", [`i10-${other}`]: "enabled" }),
      store,
      service,
    })
    expect(summary).toEqual({ checked: 2, changed: 1, failed: 0 })
    expect(service.apply).toHaveBeenCalledTimes(1)
    expect(service.apply).toHaveBeenCalledWith(
      expect.objectContaining({ sesTenant: `i10-${WORKSPACE}`, status: "disabled" }),
      "poll",
    )
  })

  it("reports our own tenant only when it is paused", async () => {
    const { store } = memoryStore()
    const service = { apply: mock(async () => "system" as const) }

    await pollTenantStatuses({
      reader: reader({ "i10-internal": "enabled" }),
      store,
      service,
    })
    expect(service.apply).not.toHaveBeenCalled()

    await pollTenantStatuses({
      reader: reader({ "i10-internal": "disabled" }),
      store,
      service,
    })
    expect(service.apply).toHaveBeenCalledTimes(1)
  })

  it("counts a tenant it could not read and carries on", async () => {
    const { store } = memoryStore()
    const service = { apply: mock(async () => "changed" as const) }
    const failing: TenantStatusReader = {
      tenants: async () => ["i10-internal", `i10-${WORKSPACE}`],
      status: async (t) => {
        if (t === "i10-internal") throw new Error("throttled")
        return "disabled"
      },
    }
    const summary = await pollTenantStatuses({ reader: failing, store, service })
    expect(summary).toEqual({ checked: 1, changed: 1, failed: 1 })
  })
})

describe("accept refuses a paused workspace", () => {
  const deps = (over: Partial<AcceptOps> = {}) =>
    ({
      persist: mock(async () => ({ status: "written" as const, ids: ["m"], refs: [] })),
      suppressedFor: async () => new Set<string>(),
      sendableFrom: async (_t: string, d: string[]) => new Set(d),
      enqueue: mock(async () => {}),
      metering: unmetered,
      log: { warn: mock(), error: mock() },
      ...over,
    }) as AcceptOps & {
      metering: Metering
      log: { warn: () => void; error: () => void }
    }

  const send = (d: ReturnType<typeof deps>) =>
    acceptSend(
      {
        tenantId: WORKSPACE,
        apiKeyId: "key-1",
        endpoint: "single",
        payloads: [
          { from: "hi@acme.com", to: "a@b.com", subject: "Hi", text: "x" } as SendEmail,
        ],
      },
      d,
    )

  it("refuses before writing anything, and says why", async () => {
    const d = deps({ sendingPaused: async () => ({ cause: "High bounce rate." }) })
    const outcome = await send(d)
    expect(outcome.status).toBe("paused")
    expect(outcome.status === "paused" && outcome.message).toContain(
      "High bounce rate.",
    )
    expect(d.persist).not.toHaveBeenCalled()
  })

  it("sends when the workspace is not paused, or nothing reports it", async () => {
    expect((await send(deps({ sendingPaused: async () => null }))).status).toBe(
      "accepted",
    )
    expect((await send(deps())).status).toBe("accepted")
  })
})

describe("the SES webhook routes status events", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString()

  /** A Notification signed the way SNS signs one, with our own key. */
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

  const post = (app: ReturnType<typeof createSesWebhooks>, body: unknown) =>
    app.request("/ses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  const deps = (tenantStatus?: { apply: ReturnType<typeof mock> }) => {
    const ingest = mock(async () => ({ status: "recorded", queued: 0 }))
    return {
      ingest,
      deps: {
        events: { ingest } as never,
        log: { info: mock(), warn: mock(), error: mock() },
        fetchCertificate: async () => pem,
        ...(tenantStatus ? { tenantStatus: tenantStatus as never } : {}),
      },
    }
  }

  it("hands a verified status event to the status service, not to ingestion", async () => {
    const apply = mock(async () => "changed")
    const { deps: d } = deps({ apply })
    const res = await post(createSesWebhooks(d), signed(disabledEvent()))

    expect(res.status).toBe(200)
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ sesTenant: `i10-${WORKSPACE}`, status: "disabled" }),
      "event",
    )
  })

  it("answers 500 so SNS redelivers when the status cannot be written", async () => {
    const apply = mock(async () => {
      throw new Error("db down")
    })
    const { deps: d } = deps({ apply })
    expect((await post(createSesWebhooks(d), signed(disabledEvent()))).status).toBe(500)
  })

  it("acknowledges a reputation finding without acting on it", async () => {
    const apply = mock(async () => "changed")
    const { deps: d } = deps({ apply })
    const res = await post(
      createSesWebhooks(d),
      signed({
        ...disabledEvent(),
        "detail-type": "Advisor Recommendation Status Open",
      }),
    )
    expect(res.status).toBe(200)
    expect(apply).not.toHaveBeenCalled()
  })

  it("still refuses an unsigned status event", async () => {
    const apply = mock(async () => "changed")
    const { deps: d } = deps({ apply })
    const forged = { ...signed(disabledEvent()), Signature: "AAAA" }
    expect((await post(createSesWebhooks(d), forged)).status).toBe(403)
    expect(apply).not.toHaveBeenCalled()
  })
})
