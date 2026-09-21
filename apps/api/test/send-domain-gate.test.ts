import { describe, expect, it, mock } from "bun:test"
import type { SendEmail } from "@repo/contracts"
import { acceptSend, type AcceptOps, type Logger } from "../src/send/accept.js"
import { unmetered, type Metering } from "../src/send/metering.js"

/**
 * Refusing a send from a domain that is not verified.
 *
 * ⚠ NOTHING CHECKED THIS, AND THE FAILURE IT LEFT WAS THE WORST SHAPE THERE IS.
 * `acceptSend` read the API key's scopes and nothing else about the `from`
 * domain — so a send from a domain still waiting on Amazon was accepted,
 * written, queued, and then refused by SES at delivery as "an identity that is
 * not verified". The caller got 200 and an id, the mail went nowhere, and the
 * only trace was a `failed` row in a log they had no reason to open. Somebody
 * copying the snippet out of onboarding saw the product work perfectly and
 * deliver nothing.
 *
 * ⚠ THE NEGATIVES ARE THE POINT, as they are in scope.test.ts. A gate that
 * accepts the right sends and quietly accepts the wrong ones too is
 * indistinguishable from no gate at all until somebody's mail disappears.
 */

const email = (over: Partial<SendEmail> = {}): SendEmail =>
  ({
    from: "hello@acme.com",
    to: "user@example.com",
    subject: "Hi",
    text: "body",
    ...over,
  }) as SendEmail

function ops(sendable: string[]) {
  const persist = mock(async (input: { messages: unknown[] }) => ({
    status: "written" as const,
    ids: input.messages.map((_, i) => `msg-${i}`),
    refs: input.messages.map((_, i) => ({ id: `msg-${i}`, createdAt: new Date() })),
  }))
  const enqueue = mock(async () => {})
  const allowed = new Set(sendable)

  return {
    persist,
    enqueue,
    deps: {
      persist,
      enqueue,
      suppressedFor: mock(async () => new Set<string>()),
      sendableFrom: mock(
        async (_tenantId: string, domains: string[]) =>
          new Set(domains.filter((d) => allowed.has(d))),
      ),
      metering: unmetered,
      log: { warn: mock(), error: mock() },
    } as unknown as AcceptOps & { metering: Metering; log: Logger },
  }
}

const send = (
  deps: ReturnType<typeof ops>["deps"],
  payloads: SendEmail[] = [email()],
) =>
  acceptSend(
    { tenantId: "t-1", apiKeyId: "k-1", payloads, endpoint: "single" as const },
    deps,
  )

describe("sending from a verified domain", () => {
  it("is accepted", async () => {
    const { deps, persist } = ops(["acme.com"])

    const result = await send(deps)

    expect(result.status).toBe("accepted")
    expect(persist).toHaveBeenCalledTimes(1)
  })
})

describe("sending from a domain that is not verified", () => {
  /**
   * ⚠ REFUSED BEFORE ANYTHING IS WRITTEN OR QUEUED, which is the whole
   * improvement. The old behaviour persisted the message and enqueued it, so
   * the customer's log filled with `failed` rows for mail they were told had
   * been accepted.
   */
  it("is refused without persisting or queueing", async () => {
    const { deps, persist, enqueue } = ops([])

    const result = await send(deps)

    expect(result.status).toBe("unverified_domain")
    expect(persist).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("names the domain, so the message says what to finish", async () => {
    const { deps } = ops([])
    const result = await send(deps)

    expect(result.status === "unverified_domain" && result.message).toContain(
      "acme.com",
    )
  })

  /**
   * ⚠ EVERY PAYLOAD, NOT THE FIRST — the same rule the key-scope check follows.
   * A batch is one request with many `from` addresses, and forty-nine
   * legitimate messages carrying one unverified domain is exactly the case a
   * first-element check misses.
   */
  it("refuses a batch where only one element is unverified", async () => {
    const { deps, persist } = ops(["acme.com"])

    const result = await acceptSend(
      {
        tenantId: "t-1",
        apiKeyId: "k-1",
        payloads: [email(), email({ from: "hi@not-verified.com" })],
        endpoint: "batch" as const,
      },
      deps,
    )

    expect(result.status).toBe("unverified_domain")
    expect(persist).not.toHaveBeenCalled()
  })

  /**
   * ⚠ AN UNPARSEABLE `from` IS REFUSED RATHER THAN WAVED THROUGH. It cannot be
   * verified by definition, and accepting it only moves the refusal to SES —
   * which is the behaviour this whole gate exists to stop.
   */
  it("refuses a from address with no domain at all", async () => {
    const { deps, persist } = ops(["acme.com"])

    const result = await send(deps, [email({ from: "not-an-address" })])

    expect(result.status).toBe("unverified_domain")
    expect(persist).not.toHaveBeenCalled()
  })

  /**
   * ⚠ EXACT MATCH, NOT SUFFIX, WHICH IS THE RULE `maySendFrom` ALREADY SETS FOR
   * KEY SCOPES. `mail.acme.com` is a separate row in `core.domains` with its
   * own verification and its own DKIM key — the add form even recommends it as
   * a way to keep sending reputation apart. Treating the apex as licensing its
   * subdomains would let a domain somebody deliberately kept separate send on
   * the strength of one they did not.
   */
  it("does not let a verified apex license its subdomain", async () => {
    const { deps } = ops(["acme.com"])

    const result = await send(deps, [email({ from: "hi@mail.acme.com" })])

    expect(result.status).toBe("unverified_domain")
  })

  /** And the reverse, which is the phishing-shaped one. */
  it("does not let a verified domain license a lookalike", async () => {
    const { deps } = ops(["acme.com"])

    const result = await send(deps, [email({ from: "hi@evil-acme.com" })])

    expect(result.status).toBe("unverified_domain")
  })
})

describe("the port's shape", () => {
  /**
   * ⚠ IT ANSWERS WITH WHAT IS ALLOWED, SO AN ADAPTER THAT RETURNS NOTHING FAILS
   * CLOSED. Shaped the other way round — a set of what is refused — a query
   * that errored and returned empty would read as "everything is permitted",
   * which is the wrong direction for this question to break in. This is the
   * test that would catch somebody inverting it.
   */
  it("refuses everything when the adapter answers with nothing", async () => {
    const { deps, persist } = ops([])
    deps.sendableFrom = mock(async () => new Set<string>())

    const result = await send(deps)

    expect(result.status).toBe("unverified_domain")
    expect(persist).not.toHaveBeenCalled()
  })

  // ⚠ ASKED ABOUT THE REQUEST'S DOMAINS, DEDUPED. A tenant with four hundred
  // domains must not put four hundred rows on the wire to check one address.
  it("asks only about the distinct domains in the request", async () => {
    const { deps } = ops(["acme.com"])

    await acceptSend(
      {
        tenantId: "t-1",
        apiKeyId: "k-1",
        payloads: [email(), email(), email({ from: "other@acme.com" })],
        endpoint: "batch" as const,
      },
      deps,
    )

    expect(deps.sendableFrom).toHaveBeenCalledWith("t-1", ["acme.com"])
  })
})
