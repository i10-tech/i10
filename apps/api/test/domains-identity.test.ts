import { describe, expect, it } from "bun:test"
import type { SESv2Client } from "@aws-sdk/client-sesv2"
import { offlineIdentity, sesIdentity } from "../src/domains/identity.js"

/**
 * The SES adapter, and the one answer it used to treat as a crash.
 *
 * ⚠ `GetEmailIdentity` RAISES `NotFoundException` FOR A NAME SES HAS NEVER
 * HEARD OF, WHICH IS THE ORDINARY STATE OF EVERY DOMAIN UNTIL `create`
 * SUCCEEDS. Nothing caught it, so it came out of `verify` as an unhandled
 * throw, the API answered its generic 500 — "Something went wrong." — and the
 * console said "Could not check the records" about a domain whose delegation
 * was working and whose records we had published ourselves. It never cleared,
 * because nothing about pressing Verify again changed the condition.
 *
 * ⚠ AND THERE ARE TWO WAYS TO REACH THAT CALL WITHOUT AN IDENTITY EXISTING.
 * `registerIdentity` returns early for a row with no DKIM selector or no
 * sealed private key, and `DomainStore.refresh` — which the console polls —
 * asks about any domain past `not_started` without registering anything.
 */

/** A client that answers each command by its constructor name. */
const client = (answers: Record<string, unknown>): SESv2Client =>
  ({
    send: async (command: object) => {
      const answer = answers[command.constructor.name]
      if (answer instanceof Error) throw answer
      return answer ?? {}
    },
  }) as unknown as SESv2Client

const notFound = () =>
  Object.assign(new Error("Identity does not exist"), { name: "NotFoundException" })

describe("asking SES about an identity that is not there", () => {
  it("answers not_started rather than throwing", async () => {
    const identity = sesIdentity(client({ GetEmailIdentityCommand: notFound() }))
    expect(await identity.status("example.com")).toEqual({ status: "not_started" })
  })

  /**
   * ⚠ EVERY OTHER FAILURE STILL THROWS, AND THAT IS THE HALF WORTH GUARDING.
   * Swallowing an AccessDenied would turn a broken IAM policy into a domain
   * that is permanently, quietly `not_started` — which reads as "the customer
   * has not finished" and sends nobody to look at the thing that is wrong.
   */
  it("still throws for anything that is not a missing identity", async () => {
    const denied = Object.assign(new Error("not authorized"), {
      name: "AccessDeniedException",
    })
    const identity = sesIdentity(client({ GetEmailIdentityCommand: denied }))

    await expect(identity.status("example.com")).rejects.toThrow("not authorized")
  })
})

describe("reading a real identity", () => {
  it("maps SES's DKIM vocabulary to ours", async () => {
    const identity = sesIdentity(
      client({ GetEmailIdentityCommand: { DkimAttributes: { Status: "SUCCESS" } } }),
    )
    expect(await identity.status("example.com")).toEqual({ status: "verified" })
  })

  /*
   * ⚠ `TEMPORARY_FAILURE` IS NOT `FAILED`. One means wait and one means go and
   * change your DNS, and telling the first person the second story sends them
   * to re-check records that are already correct.
   */
  it("keeps a temporary failure apart from a permanent one", async () => {
    const identity = sesIdentity(
      client({
        GetEmailIdentityCommand: { DkimAttributes: { Status: "TEMPORARY_FAILURE" } },
      }),
    )
    expect(await identity.status("example.com")).toEqual({
      status: "temporary_failure",
    })
  })
})

describe("the offline identity", () => {
  // ⚠ `pending`, NEVER `verified`. A stub that claimed verification would let
  // local work through every gate that exists to stop unverified mail.
  it("reports pending and never throws", async () => {
    const identity = offlineIdentity()
    expect(await identity.status("example.com")).toEqual({ status: "pending" })
    await identity.remove("example.com")
  })
})
