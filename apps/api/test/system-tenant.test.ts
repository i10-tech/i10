import { describe, expect, it, mock } from "bun:test"
import { systemTenancy, withSystemTenant } from "../src/send/system-tenant.js"
import type { OutboundMessage, Transport } from "../src/send/transport.js"
import { SYSTEM_FROM, SYSTEM_SES_TENANT } from "../src/system-mail.js"

/**
 * Our own mail's SES tenant (#206).
 *
 * ⚠ THE FAILURE WORTH GUARDING IS NAMING THE TENANT BEFORE THE ATTACH WORKED.
 * SES refuses a tenant send whose identity the tenant does not hold, and the
 * mail at stake is sign-in codes - so a failed attach must mean "send as we
 * always did", never "send and be refused".
 */

/** An SES account where only `i10.tech` is an identity, as in production. */
const identityFake = (attach = mock(async () => {})) => ({
  attach,
  signature: mock(async (domain: string) =>
    domain === "i10.tech"
      ? { origin: "EXTERNAL", tokens: ["i10abc"] }
      : { origin: null, tokens: [] },
  ),
})

const message = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: "m-1",
  tenantId: "t-1",
  from: "i10 <no-reply@notifications.i10.tech>",
  to: ["a@b.com"],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "Your code",
  ...over,
})

const recordingTransport = () => {
  const sent: OutboundMessage[] = []
  const transport: Transport = {
    send: async (m) => {
      sent.push(m)
      return { status: "sent", providerMessageId: "p-1" }
    },
  }
  return { transport, sent }
}

describe("systemTenancy", () => {
  it("defaults the sender to no-reply@notifications.i10.tech", () => {
    expect(SYSTEM_FROM).toBe("i10 <no-reply@notifications.i10.tech>")
  })

  /**
   * ⚠ `notifications.i10.tech` HAS NO IDENTITY; SES SENDS IT UNDER `i10.tech`.
   * Attaching the subdomain would fail, and attaching nothing would leave the
   * tenant refusing every send.
   */
  it("attaches the nearest identity that covers the sender", async () => {
    const identity = identityFake()
    const tenancy = systemTenancy({ from: SYSTEM_FROM, identity })

    expect(await tenancy.tenantFor("no-reply@notifications.i10.tech")).toBe(
      SYSTEM_SES_TENANT,
    )
    expect(identity.attach).toHaveBeenCalledWith("i10.tech", "i10-internal")
  })

  it("ignores mail from any other domain", async () => {
    const identity = identityFake()
    const tenancy = systemTenancy({ from: SYSTEM_FROM, identity })

    expect(await tenancy.tenantFor("hello@acme.com")).toBeNull()
    expect(identity.attach).not.toHaveBeenCalled()
  })

  it("names no tenant when the attach fails, and retries later", async () => {
    let clock = 0
    const attach = mock(async () => {
      throw new Error("throttled")
    })
    const log = { error: mock() }
    const tenancy = systemTenancy({
      from: SYSTEM_FROM,
      identity: identityFake(attach),
      log,
      now: () => clock,
    })

    expect(await tenancy.tenantFor(SYSTEM_FROM)).toBeNull()
    expect(log.error).toHaveBeenCalled()

    await tenancy.tenantFor(SYSTEM_FROM)
    expect(attach).toHaveBeenCalledTimes(1)

    clock += 5 * 60 * 1000
    await tenancy.tenantFor(SYSTEM_FROM)
    expect(attach).toHaveBeenCalledTimes(2)
  })

  it("trusts a success for hours, then attaches again", async () => {
    let clock = 0
    const identity = identityFake()
    const tenancy = systemTenancy({ from: SYSTEM_FROM, identity, now: () => clock })

    await tenancy.tenantFor(SYSTEM_FROM)
    clock += 60 * 60 * 1000
    await tenancy.tenantFor(SYSTEM_FROM)
    expect(identity.attach).toHaveBeenCalledTimes(1)

    clock += 6 * 60 * 60 * 1000
    await tenancy.tenantFor(SYSTEM_FROM)
    expect(identity.attach).toHaveBeenCalledTimes(2)
  })

  // A burst of sign-in codes must not fire one attach each into SES's shared
  // one-request-per-second budget for everything that is not a send.
  it("shares one attach between concurrent sends", async () => {
    const identity = identityFake()
    const tenancy = systemTenancy({ from: SYSTEM_FROM, identity })

    await Promise.all([1, 2, 3].map(() => tenancy.tenantFor(SYSTEM_FROM)))
    expect(identity.attach).toHaveBeenCalledTimes(1)
  })

  it("names no tenant when no identity covers the sender", async () => {
    const identity = {
      attach: mock(async () => {}),
      signature: mock(async () => ({ origin: null, tokens: [] })),
    }
    const tenancy = systemTenancy({ from: SYSTEM_FROM, identity })

    expect(await tenancy.tenantFor(SYSTEM_FROM)).toBeNull()
    expect(identity.attach).not.toHaveBeenCalled()
  })
})

describe("withSystemTenant", () => {
  it("fills in our tenant for our own mail", async () => {
    const { transport, sent } = recordingTransport()
    const wrapped = withSystemTenant(
      transport,
      systemTenancy({ from: SYSTEM_FROM, identity: identityFake() }),
    )

    await wrapped.send(message())
    expect(sent[0]?.sesTenant).toBe(SYSTEM_SES_TENANT)
  })

  it("never replaces a tenant the message already names", async () => {
    const { transport, sent } = recordingTransport()
    const tenancy = { tenantFor: mock(async () => SYSTEM_SES_TENANT) }

    await withSystemTenant(transport, tenancy).send(
      message({
        from: "hi@acme.com",
        sesTenant: "i10-0190a3e4-0000-7000-8000-000000000001",
      }),
    )
    expect(sent[0]?.sesTenant).toBe("i10-0190a3e4-0000-7000-8000-000000000001")
    expect(tenancy.tenantFor).not.toHaveBeenCalled()
  })

  it("sends customer mail with no tenant exactly as it was", async () => {
    const { transport, sent } = recordingTransport()
    const wrapped = withSystemTenant(
      transport,
      systemTenancy({ from: SYSTEM_FROM, identity: identityFake() }),
    )

    const original = message({ from: "hi@acme.com", sesTenant: null })
    await wrapped.send(original)
    expect(sent[0]).toBe(original)
  })
})
