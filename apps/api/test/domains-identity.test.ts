import { describe, expect, it } from "bun:test"
import type { SESv2Client } from "@aws-sdk/client-sesv2"
import { offlineIdentity, sesIdentity } from "../src/domains/identity.js"

/**
 * The SES adapter, and the one answer it used to treat as a crash.
 *
 * ⚠ `GetEmailIdentity` RAISES `NotFoundException` FOR A NAME SES HAS NEVER
 * HEARD OF, WHICH IS THE ORDINARY STATE OF EVERY DOMAIN UNTIL `create`
 * SUCCEEDS. Nothing caught it, so it came out of `verify` as an unhandled
 * throw, the API answered its generic 500 - "Something went wrong." - and the
 * console said "Could not check the records" about a domain whose delegation
 * was working and whose records we had published ourselves. It never cleared,
 * because nothing about pressing Verify again changed the condition.
 *
 * ⚠ AND THERE ARE TWO WAYS TO REACH THAT CALL WITHOUT AN IDENTITY EXISTING.
 * `registerIdentity` returns early for a row with no DKIM selector or no
 * sealed private key, and `DomainStore.refresh` - which the console polls -
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
   * that is permanently, quietly `not_started` - which reads as "the customer
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

/**
 * Pressing Verify on a domain that already works.
 *
 * ⚠ IT TOOK THE DOMAIN OUT OF SERVICE, AND IT WAS OBSERVED IN PRODUCTION.
 * `verify` always calls `registerIdentity`, which called `create`, which hit
 * `AlreadyExistsException` and re-asserted the signing attributes. That is not
 * a confirmation to SES - it is a NEW signing configuration, so SES discards
 * the result of its DKIM check and starts again: `SUCCESS` drops to `PENDING`
 * and `VerifiedForSendingStatus` goes false. The send gate reads exactly that,
 * so a verified domain stopped being able to send until Amazon re-checked.
 *
 * The sequence was: verified in the dashboard and in SES → pressed Verify →
 * both said pending → both verified again some minutes later.
 */

/** A client that records which commands it was given. */
const recording = (answers: Record<string, unknown>) => {
  const sent: string[] = []
  const c = {
    send: async (command: object) => {
      sent.push(command.constructor.name)
      const answer = answers[command.constructor.name]
      if (answer instanceof Error) throw answer
      return answer ?? {}
    },
  } as unknown as SESv2Client
  return { client: c, sent }
}

const verifiedIdentity = (over: Record<string, unknown> = {}) => ({
  DkimAttributes: {
    Status: "SUCCESS",
    SigningAttributesOrigin: "EXTERNAL",
    Tokens: ["i10abc123def456"],
    ...((over.DkimAttributes as object) ?? {}),
  },
  MailFromAttributes: {
    MailFromDomain: "send.example.com",
    MailFromDomainStatus: "SUCCESS",
    ...((over.MailFromAttributes as object) ?? {}),
  },
  VerifiedForSendingStatus: true,
})

const ours = {
  domain: "example.com",
  mailFrom: "send.example.com",
  selector: "i10abc123def456",
  privateKey: "cHJpdmF0ZQ==",
}

describe("re-registering an identity that is already ours", () => {
  it("writes nothing, so a verified domain stays verified", async () => {
    const { client: c, sent } = recording({
      GetEmailIdentityCommand: verifiedIdentity(),
    })

    const out = await sesIdentity(c).create(ours)

    expect(out).toEqual({ status: "verified" })
    /*
     * ⚠ THE ASSERTION THAT MATTERS. Either Put would reset the verification;
     * `CreateEmailIdentity` would too, by way of the AlreadyExists branch.
     */
    expect(sent).toEqual(["GetEmailIdentityCommand"])
  })

  /**
   * ⚠ AND A DIFFERENT KEY MUST STILL BE RE-ASSERTED, which is the whole reason
   * the old code did this unconditionally. A domain that changed hands, or a
   * rotation that half-applied, leaves SES signing with a key the customer's
   * DNS no longer publishes - every signature fails while the records look
   * perfectly correct. Skipping that case to protect the verified one would
   * trade a visible outage for an invisible one.
   */
  it("still re-asserts when the identity carries somebody else's selector", async () => {
    const { client: c, sent } = recording({
      GetEmailIdentityCommand: verifiedIdentity({
        DkimAttributes: {
          Status: "SUCCESS",
          SigningAttributesOrigin: "EXTERNAL",
          Tokens: ["i10999999999999"],
        },
      }),
      CreateEmailIdentityCommand: Object.assign(new Error("exists"), {
        name: "AlreadyExistsException",
      }),
    })

    await sesIdentity(c).create(ours)

    expect(sent).toContain("PutEmailIdentityDkimSigningAttributesCommand")
  })

  /**
   * ⚠ A MOVED RETURN PATH IS NOT A REASON TO RESET DKIM. Turning delegation on
   * moves MAIL FROM under `mail.`, which is a change to one attribute - and
   * re-asserting the key alongside it would un-verify a domain for a reason
   * that has nothing to do with the key.
   */
  it("writes only the return path when that is the only thing that moved", async () => {
    const { client: c, sent } = recording({
      GetEmailIdentityCommand: verifiedIdentity({
        MailFromAttributes: { MailFromDomain: "send.mail.example.com" },
      }),
    })

    await sesIdentity(c).create(ours)

    expect(sent).toContain("PutEmailIdentityMailFromAttributesCommand")
    expect(sent).not.toContain("PutEmailIdentityDkimSigningAttributesCommand")
    expect(sent).not.toContain("CreateEmailIdentityCommand")
  })

  /** ⚠ AND A DOMAIN SES HAS NEVER HEARD OF IS STILL CREATED, obviously. */
  it("creates the identity when there is none", async () => {
    const { client: c, sent } = recording({ GetEmailIdentityCommand: notFound() })

    await sesIdentity(c).create(ours)

    expect(sent).toContain("CreateEmailIdentityCommand")
    expect(sent).toContain("PutEmailIdentityMailFromAttributesCommand")
  })
})

/**
 * SES tenants (#156): one per workspace, the identity in exactly one of ours.
 *
 * ⚠ AND A DELETE MUST DETACH FIRST. SES refuses to delete an identity a tenant
 * still holds, and the store's `tidy` swallows that refusal by design - so a
 * delete that did not detach would leak a live identity silently, the same way
 * the missing IAM permission once did.
 */
describe("SES tenants", () => {
  /** A client that records each command with its input. */
  const tenantClient = (answers: Record<string, unknown> = {}) => {
    const sent: { name: string; input: Record<string, unknown> }[] = []
    const c = {
      send: async (command: { input: Record<string, unknown> }) => {
        const name = command.constructor.name
        sent.push({ name, input: command.input })
        const answer = answers[name]
        if (answer instanceof Error) throw answer
        return answer ?? {}
      },
    } as unknown as SESv2Client
    return { client: c, sent }
  }

  const options = {
    region: "eu-central-1",
    accountId: "123456789012",
    configurationSet: "i10-prod",
  }
  const exists = (name: string) =>
    Object.assign(new Error(`${name} already exists`), {
      name: "AlreadyExistsException",
    })

  it("creates the tenant and associates both the identity and the configuration set", async () => {
    const { client: c, sent } = tenantClient()
    await sesIdentity(c, options).attach("example.com", "i10-ten")

    expect(sent.map((s) => s.name)).toEqual([
      "CreateTenantCommand",
      "CreateTenantResourceAssociationCommand",
      "CreateTenantResourceAssociationCommand",
      "ListResourceTenantsCommand",
    ])
    expect(sent[1]!.input).toEqual({
      TenantName: "i10-ten",
      ResourceArn: "arn:aws:ses:eu-central-1:123456789012:identity/example.com",
    })
    expect(sent[2]!.input).toEqual({
      TenantName: "i10-ten",
      ResourceArn: "arn:aws:ses:eu-central-1:123456789012:configuration-set/i10-prod",
    })
  })

  it("treats an existing tenant and existing associations as done", async () => {
    const { client: c } = tenantClient({
      CreateTenantCommand: exists("tenant"),
      CreateTenantResourceAssociationCommand: exists("association"),
    })
    await sesIdentity(c, options).attach("example.com", "i10-ten")
  })

  it("takes the identity out of any other workspace's tenant, and leaves foreign tenants alone", async () => {
    const previous = "i10-0190a3e4-0000-7000-8000-000000000001"
    const { client: c, sent } = tenantClient({
      ListResourceTenantsCommand: {
        ResourceTenants: [
          { TenantName: "i10-ten" },
          { TenantName: previous },
          { TenantName: "made-by-hand" },
        ],
      },
    })
    await sesIdentity(c, options).attach("example.com", "i10-ten")

    const detached = sent.filter(
      (s) => s.name === "DeleteTenantResourceAssociationCommand",
    )
    expect(detached.map((s) => s.input.TenantName)).toEqual([previous])
  })

  it("refuses to attach without the account and configuration set it needs", async () => {
    const { client: c } = tenantClient()
    await expect(sesIdentity(c, {}).attach("example.com", "i10-ten")).rejects.toThrow(
      /configurationSet/,
    )
  })

  it("detaches every tenant before deleting the identity", async () => {
    const { client: c, sent } = tenantClient({
      ListResourceTenantsCommand: {
        ResourceTenants: [{ TenantName: "i10-ten" }, { TenantName: "made-by-hand" }],
      },
    })
    await sesIdentity(c, options).remove("example.com")

    expect(sent.map((s) => s.name)).toEqual([
      "ListResourceTenantsCommand",
      "DeleteTenantResourceAssociationCommand",
      "DeleteTenantResourceAssociationCommand",
      "DeleteEmailIdentityCommand",
    ])
  })

  it("still deletes an identity no tenant holds", async () => {
    const { client: c, sent } = tenantClient({ ListResourceTenantsCommand: notFound() })
    await sesIdentity(c, options).remove("example.com")
    expect(sent.at(-1)!.name).toBe("DeleteEmailIdentityCommand")
  })

  it("names the tenant after the workspace, within SES's limits", async () => {
    const { sesTenantName } = await import("../src/domains/identity.js")
    const name = sesTenantName("0190a3e4-5b6c-7d8e-9f00-112233445566")
    expect(name).toBe("i10-0190a3e4-5b6c-7d8e-9f00-112233445566")
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it("does nothing offline", async () => {
    await offlineIdentity().attach("example.com", "i10-ten")
  })
})
