import { describe, expect, it, mock } from "bun:test"
import type { SendEmail } from "@repo/contracts"
import { acceptSend, type AcceptOps } from "../src/send/accept.js"
import { unmetered, type Metering } from "../src/send/metering.js"
import {
  domainScope,
  isRestricted,
  maySendFrom,
  scopedDomains,
} from "../src/auth/scope.js"

/**
 * What a restricted key may do.
 *
 * ⚠ THE COLUMN EXISTED FOR A YEAR AND WAS ENFORCED NOWHERE, so these tests are
 * the first thing that has ever asserted a scope means anything. The ones that
 * matter most are the negatives: a restriction that is carried, displayed and
 * never checked looks identical to one that works, right up until a leaked key
 * sends as somebody's primary domain.
 */

const email = (over: Partial<SendEmail> = {}): SendEmail =>
  ({
    from: "hello@acme.com",
    to: "user@example.com",
    subject: "Hi",
    text: "body",
    ...over,
  }) as SendEmail

function ops() {
  const persist = mock(async (input: { messages: unknown[] }) => ({
    status: "written" as const,
    ids: input.messages.map((_, i) => `msg-${i}`),
    refs: input.messages.map((_, i) => ({
      id: `msg-${i}`,
      createdAt: new Date("2026-09-20T10:00:00Z"),
    })),
  }))
  const enqueue = mock(async () => {})
  return {
    persist,
    enqueue,
    deps: {
      persist,
      enqueue,
      suppressedFor: mock(async () => new Set<string>()),
      metering: unmetered,
      log: { warn: mock(), error: mock() },
    } as unknown as AcceptOps & {
      metering: Metering
      log: { warn: () => void; error: () => void }
    },
  }
}

const send = (scopes: readonly string[] | undefined, payloads: SendEmail[]) => {
  const { deps, persist, enqueue } = ops()
  return acceptSend(
    { tenantId: "ten-1", apiKeyId: "key-1", scopes, payloads, endpoint: "single" },
    deps,
  ).then((outcome) => ({ outcome, persist, enqueue }))
}

describe("reading a scope", () => {
  it("finds the domains and ignores everything else", () => {
    expect(scopedDomains([domainScope("Acme.com"), "emails:write"])).toEqual([
      "acme.com",
    ])
  })

  /*
   * ⚠ AN UNKNOWN SCOPE STRING IS NOT A RESTRICTION. The column is a free
   * `text[]` that predates this file; reading a stray value as a domain would
   * lock somebody out of their own account over a typo in a SQL console.
   */
  it("treats a key with no domain scope as unrestricted", () => {
    expect(isRestricted(["emails:write", "whatever"])).toBe(false)
    expect(maySendFrom(["emails:write"], "anything.com")).toBe(true)
  })

  it("treats an empty scope list as unrestricted", () => {
    expect(maySendFrom([], "acme.com")).toBe(true)
    expect(isRestricted([])).toBe(false)
  })

  /*
   * ⚠ EXACT MATCH, NOT SUFFIX, AND A SUBDOMAIN IS A DIFFERENT DOMAIN. In
   * `core.domains` `mail.acme.com` is its own row with its own verification and
   * its own DKIM key — often kept separate on purpose, so its reputation does
   * not touch the apex. A key scoped to the apex must not reach it.
   */
  it("does not let a scope for an apex cover its subdomains", () => {
    expect(maySendFrom([domainScope("acme.com")], "mail.acme.com")).toBe(false)
  })

  // ⚠ AND THE OBVIOUS ATTACK: a suffix check would accept this.
  it("does not let a scope cover a domain that merely ends with it", () => {
    expect(maySendFrom([domainScope("acme.com")], "evil-acme.com")).toBe(false)
    expect(maySendFrom([domainScope("acme.com")], "acme.com.evil.test")).toBe(false)
  })

  it("is case-insensitive in both directions, because a domain is", () => {
    expect(maySendFrom([domainScope("ACME.com")], "acme.COM")).toBe(true)
  })

  /*
   * ⚠ A RESTRICTED KEY WITH NO READABLE `from` IS REFUSED, NOT WAVED THROUGH.
   * A restriction that cannot be shown to be satisfied has not been satisfied.
   */
  it("refuses a restricted key when the from address has no domain", () => {
    expect(maySendFrom([domainScope("acme.com")], null)).toBe(false)
  })
})

describe("sending with a restricted key", () => {
  it("accepts a message from the domain it is scoped to", async () => {
    const { outcome } = await send([domainScope("acme.com")], [email()])
    expect(outcome.status).toBe("accepted")
  })

  it("refuses a message from any other domain", async () => {
    const { outcome } = await send(
      [domainScope("staging.acme.com")],
      [email({ from: "hello@acme.com" })],
    )
    expect(outcome).toMatchObject({
      status: "forbidden",
      message: expect.stringContaining("staging.acme.com"),
    })
  })

  /*
   * ⚠ NOTHING IS WRITTEN AND NOTHING IS QUEUED. A refusal that has already
   * persisted the message leaves a row the dashboard shows as sent-ish, and on
   * a batch it would leave some elements written and some not.
   */
  it("writes nothing when it refuses", async () => {
    const { outcome, persist, enqueue } = await send(
      [domainScope("staging.acme.com")],
      [email()],
    )
    expect(outcome.status).toBe("forbidden")
    expect(persist).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })

  /*
   * ⚠ THE CASE A FIRST-ELEMENT CHECK MISSES, and the reason every payload is
   * inspected. Forty-nine legitimate messages and one from the production
   * domain is exactly how somebody would use a leaked staging key.
   */
  it("refuses a batch where only one element is out of scope", async () => {
    const { outcome, persist } = await send(
      [domainScope("staging.acme.com")],
      [
        email({ from: "a@staging.acme.com" }),
        email({ from: "b@staging.acme.com" }),
        email({ from: "sales@acme.com" }),
      ],
    )
    expect(outcome).toMatchObject({ status: "forbidden" })
    expect(persist).not.toHaveBeenCalled()
  })

  /*
   * ⚠ i10'S OWN MAIL HAS NO KEY AT ALL, and the failure mode of getting this
   * backwards is every message in the product refused at once.
   */
  it("leaves a caller that passes no scopes alone", async () => {
    const { outcome } = await send(undefined, [email({ from: "x@anything.test" })])
    expect(outcome.status).toBe("accepted")
  })
})
