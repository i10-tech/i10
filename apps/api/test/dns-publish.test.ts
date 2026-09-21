import { describe, expect, it, mock } from "bun:test"
import type { Domain } from "@repo/contracts"
import { dnsPublisher } from "../src/dns/publish.js"
import { RECORD_TTL } from "../src/domains/zone.js"
import type { DnsConnectionStore } from "../src/dns/connections.js"
import { DnsWriteError, type PublishOutcome, type ZoneWriter } from "../src/dns/port.js"

/**
 * Publishing a domain's records into the customer's own DNS.
 *
 * ⚠ THE PUBLISHER ITSELF WRITES NOTHING AND DECIDES EVERYTHING: which zone, on
 * whose credential, and — the part that matters — whether a blocked publish is
 * reported as a refusal or quietly treated as a success. The adapters signal a
 * refusal by a SHAPE (`removed` populated, nothing created or unchanged) rather
 * than by throwing, so a reader of this file that gets the condition slightly
 * wrong turns "we refused to delete your DMARC record" into "published".
 */

const NOW = new Date("2026-09-19T12:00:00.000Z")

const domain = (records: Domain["records"] = []): Domain => ({
  object: "domain",
  id: "0199a3f2-b4c1-7f3e-9d2a-8b1c4e5f60bb",
  name: "example.com",
  status: "pending",
  created_at: NOW.toISOString(),
  region: "eu-central-1",
  delegated: true,
  records,
})

const nsRecords: Domain["records"] = [
  {
    record: "NS",
    name: "mail.example.com",
    type: "NS",
    ttl: "Auto",
    status: "pending",
    value: "ns1.i10.tech",
  },
]

const outcome = (over: Partial<PublishOutcome> = {}): PublishOutcome => ({
  created: [],
  unchanged: [],
  removed: [],
  ...over,
})

const writer = (over: Partial<ZoneWriter> = {}): ZoneWriter => ({
  zones: async () => [{ id: "z1", name: "example.com" }],
  publish: async () => outcome({ created: [] }),
  ...over,
})

function connections(over: Partial<DnsConnectionStore> = {}) {
  const noteUse = mock<
    (i: { tenantId: string; provider: string; error: string | null }) => Promise<void>
  >(async () => {})
  const store = {
    list: async () => [],
    get: async () => ({
      provider: "cloudflare",
      credential: { accessToken: "stub-not-a-real-token" },
    }),
    save: async () => ({}) as never,
    remove: async () => true,
    noteUse,
    ...over,
  } as unknown as DnsConnectionStore
  return { store, noteUse }
}

const log = { warn: mock(() => {}) }

/**
 * ⚠ THE WRITER IS INJECTED, so nothing here touches a real provider adapter —
 * each of those has its own file. `cloudflare` is only a slug the tests pass
 * through; `unsupported` is proved by asking for a slug the registry has no
 * writer for.
 */
const publisherWith = (w: ZoneWriter, conn = connections()) => ({
  publisher: dnsPublisher({ connections: conn.store, log, writers: () => w }),
  conn,
})

/**
 * Who may clear a record that looks like ours.
 *
 * ⚠ THE CLEAN-UP IS THE ONLY DESTRUCTIVE THING THIS MODULE DOES WITHOUT
 * ASKING, AND THIS IS THE GATE ON IT. A name can be held by more than one
 * workspace — migration 0039 exists to allow exactly that — so a record in
 * our shape at a name we publish to may be another workspace's LIVE
 * delegation rather than litter from a domain that was deleted. Only
 * `core.verified_holder` can tell the two apart, and every answer other than
 * "nobody, or us" has to mean no.
 */
describe("clearing records of our own", () => {
  const seen = () => {
    const calls: { clearSuperseded?: boolean }[] = []
    return {
      calls,
      writer: writer({
        publish: async (_c, _z, _r, options = {}) => {
          calls.push(options)
          return outcome({ created: [] })
        },
      }),
    }
  }

  it("is asked for when nobody has proven the name", async () => {
    const { calls, writer: w } = seen()
    const conn = connections()
    await dnsPublisher({
      connections: conn.store,
      log,
      writers: () => w,
      claims: { verifiedHolder: async () => null },
    }).publish({ tenantId: "t1", provider: "cloudflare", domain: domain(nsRecords) })

    expect(calls[0]?.clearSuperseded).toBe(true)
  })

  it("is asked for when the holder is this very domain", async () => {
    const { calls, writer: w } = seen()
    const conn = connections()
    const mine = domain(nsRecords)
    await dnsPublisher({
      connections: conn.store,
      log,
      writers: () => w,
      claims: { verifiedHolder: async () => mine.id },
    }).publish({ tenantId: "t1", provider: "cloudflare", domain: mine })

    expect(calls[0]?.clearSuperseded).toBe(true)
  })

  /*
   * ⚠ THE CASE THE GATE EXISTS FOR. Somebody else has proven this name, so
   * the records in that zone that look like ours are theirs and working.
   */
  it("is refused when another domain holds the name verified", async () => {
    const { calls, writer: w } = seen()
    const conn = connections()
    await dnsPublisher({
      connections: conn.store,
      log,
      writers: () => w,
      claims: { verifiedHolder: async () => "someone-elses-domain-id" },
    }).publish({ tenantId: "t1", provider: "cloudflare", domain: domain(nsRecords) })

    expect(calls[0]?.clearSuperseded).toBe(false)
  })

  // ⚠ AND AN UNREADABLE ANSWER IS A NO, not an assumption in either direction.
  it("is refused when the question cannot be answered", async () => {
    const { calls, writer: w } = seen()
    const conn = connections()
    const result = await dnsPublisher({
      connections: conn.store,
      log,
      writers: () => w,
      claims: {
        verifiedHolder: async () => {
          throw new Error("the database is down")
        },
      },
    }).publish({ tenantId: "t1", provider: "cloudflare", domain: domain(nsRecords) })

    expect(calls[0]?.clearSuperseded).toBe(false)
    // ⚠ AND THE PUBLISH ITSELF STILL HAPPENS. The gate withholds a tidy-up,
    // never the records the customer is waiting on.
    expect(result.status).toBe("published")
  })

  // ⚠ A DEPLOYMENT THAT DOES NOT WIRE THE CHECK DOES NOT GET THE CLEAN-UP.
  it("is refused when nothing can answer at all", async () => {
    const { calls, writer: w } = seen()
    const conn = connections()
    await dnsPublisher({ connections: conn.store, log, writers: () => w }).publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: domain(nsRecords),
    })

    expect(calls[0]?.clearSuperseded).toBe(false)
  })
})

describe("before anything is written", () => {
  it("says so when we cannot write to that provider at all", async () => {
    const { store } = connections()
    const result = await dnsPublisher({ connections: store, log }).publish({
      tenantId: "t1",
      provider: "some-registrar-we-cannot-write-to",
      domain: domain(nsRecords),
    })
    expect(result.status).toBe("unsupported")
  })

  it("says so when the workspace has not connected that provider", async () => {
    const conn = connections({ get: async () => null })
    const result = await dnsPublisher({ connections: conn.store, log }).publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: domain(nsRecords),
    })
    expect(result.status).toBe("not_connected")
  })

  /**
   * ⚠ AND IT LISTS WHAT THE CREDENTIAL CAN SEE. "We cannot find example.com" is
   * a dead end; "this connection holds other.com and elsewhere.net" tells
   * somebody they connected the wrong account, which is the actual mistake.
   */
  it("reports which zones the credential does reach", async () => {
    const { publisher } = publisherWith(
      writer({
        zones: async () => [
          { id: "a", name: "other.com" },
          { id: "b", name: "elsewhere.net" },
        ],
      }),
    )

    const result = await publisher.publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: domain(nsRecords),
    })

    expect(result).toEqual({
      status: "zone_not_found",
      zones: ["other.com", "elsewhere.net"],
    })
  })
})

describe("a publish the adapter refused", () => {
  /**
   * ⚠ THE REFUSAL IS A SHAPE, NOT AN EXCEPTION, and this is the assertion that
   * keeps a customer's DMARC record alive. The adapter returns the conflicts in
   * `removed` having written nothing; reading that as success would report
   * "published" for a run that did nothing and leave the delegation broken.
   */
  it("is reported as needing confirmation, not as published", async () => {
    const conflicts = [
      {
        name: "_dmarc.example.com",
        type: "TXT",
        value: "v=DMARC1; p=reject;",
        reason: "A TXT record already exists at _dmarc.example.com.",
      },
    ]
    const { publisher, conn } = publisherWith(
      writer({ publish: async () => outcome({ removed: conflicts }) }),
    )

    const result = await publisher.publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: domain(nsRecords),
    })

    expect(result).toEqual({ status: "needs_confirmation", conflicts })
    // ⚠ NOT COUNTED AS A SUCCESSFUL USE EITHER — nothing was written.
    expect(conn.noteUse).not.toHaveBeenCalled()
  })

  /**
   * ⚠ BUT A RUN THAT ACTUALLY REMOVED THINGS IS A SUCCESS, because the customer
   * already agreed. Treating `removed.length > 0` alone as a refusal would make
   * the confirmed second call loop for ever, confirming the same conflicts.
   */
  it("is a success once the customer has confirmed", async () => {
    const { publisher } = publisherWith(
      writer({
        publish: async () =>
          outcome({
            removed: [
              { name: "_dmarc.example.com", type: "TXT", value: "x", reason: "y" },
            ],
            created: [
              {
                name: "_dmarc.example.com",
                type: "NS",
                value: "ns1.i10.tech",
                ttl: 300,
              },
            ],
          }),
      }),
    )

    const result = await publisher.publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: domain(nsRecords),
      replaceConflicts: true,
    })

    expect(result.status).toBe("published")
  })
})

describe("translating the records the customer is looking at", () => {
  /**
   * ⚠ `"Auto"` BECOMES `RECORD_TTL`, WHICH IS 60 AND NOT THE 300 THIS NOTE
   * USED TO CLAIM. A short TTL matters most in exactly this window: somebody
   * is watching for the record to appear, and an hour-long negative cache is
   * the difference between "it worked" and "it did nothing".
   *
   * ⚠ AND NOTHING WE ISSUE SAYS "Auto" ANY MORE — the records carry the number
   * itself. The fallback stays because a domain row created before that change
   * still has the old string in whatever the caller is holding, and mapping it
   * is one line against a publish that would otherwise write a TTL of zero.
   */
  it("turns an Auto TTL into the shared record TTL and keeps a priority", async () => {
    let sent: readonly { name: string; ttl: number; priority?: number }[] = []
    const { publisher } = publisherWith(
      writer({
        publish: async (_c, _z, records) => {
          sent = records
          return outcome({ created: [...records] })
        },
      }),
    )

    await publisher.publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: domain([
        ...nsRecords,
        {
          record: "SPF",
          name: "send.example.com",
          type: "MX",
          ttl: "Auto",
          status: "pending",
          value: "feedback-smtp.eu-central-1.amazonses.com",
          priority: 10,
        },
        {
          record: "DMARC",
          name: "_dmarc.example.com",
          type: "TXT",
          ttl: "600",
          status: "pending",
          value: "v=DMARC1; p=none;",
        },
      ]),
    })

    /*
     * ⚠ `RECORD_TTL`, NOT A NUMBER TYPED HERE. The whole point of the constant
     * is that the zones we serve and the records we write into somebody else's
     * cannot drift apart; a literal in this assertion would let them, and this
     * test would be the thing that kept the drift green.
     */
    expect(sent.map((r) => r.ttl)).toEqual([RECORD_TTL, RECORD_TTL, 600])
    expect(sent[1]?.priority).toBe(10)
    expect(sent[0]).not.toHaveProperty("priority")
  })

  /**
   * ⚠ IT PUBLISHES WHATEVER THE DOMAIN NEEDS AND NEVER DECIDES WHICH. A
   * delegated domain's `records` are NS records plus the ownership challenge; a
   * manual one's are the six. One code path serves both, which is what stops
   * the published set from drifting from the table on screen.
   */
  it("publishes a manual domain's own records without knowing they are manual", async () => {
    let names: string[] = []
    const { publisher } = publisherWith(
      writer({
        publish: async (_c, _z, records) => {
          names = records.map((r) => r.name)
          return outcome({ created: [...records] })
        },
      }),
    )

    await publisher.publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: {
        ...domain([
          {
            record: "DKIM",
            name: "sel._domainkey.example.com",
            type: "TXT",
            ttl: "Auto",
            status: "pending",
            value: "v=DKIM1; k=rsa; p=AAAA",
          },
        ]),
        delegated: false,
      },
    })

    expect(names).toEqual(["sel._domainkey.example.com"])
  })
})

describe("when the provider refuses us", () => {
  /**
   * ⚠ THE FAILURE IS WRITTEN ONTO THE CONNECTION, NOT ONLY RETURNED. A publish
   * that fails because a token was revoked fails identically every time after;
   * storing it is what lets the settings page say "this connection needs
   * reconnecting" instead of the message living in one person's toast.
   */
  it("stores the reason on the connection and keeps its kind", async () => {
    const { publisher, conn } = publisherWith(
      writer({
        publish: async () => {
          throw new DnsWriteError("forbidden", "Refused.", "Zone → DNS → Edit required")
        },
      }),
    )

    const result = await publisher.publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: domain(nsRecords),
    })

    expect(result).toEqual({
      status: "failed",
      kind: "forbidden",
      reason: "Zone → DNS → Edit required",
    })
    expect(conn.noteUse).toHaveBeenCalledWith({
      tenantId: "t1",
      provider: "cloudflare",
      error: "forbidden: Zone → DNS → Edit required",
    })
  })

  /** Anything that is not a DnsWriteError is a bug or an outage: retryable. */
  it("treats an unexpected throw as retryable rather than as a bad credential", async () => {
    const { publisher } = publisherWith(
      writer({
        zones: async () => {
          throw new TypeError("undefined is not an object")
        },
      }),
    )

    const result = await publisher.publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: domain(nsRecords),
    })

    expect(result.status === "failed" && result.kind).toBe("unavailable")
  })

  /** ⚠ A STORED ERROR IS BOUNDED. A provider can return a very long body. */
  it("truncates a very long reason before it reaches a row", async () => {
    const { publisher, conn } = publisherWith(
      writer({
        publish: async () => {
          throw new DnsWriteError("unavailable", "Refused.", "x".repeat(2000))
        },
      }),
    )

    await publisher.publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: domain(nsRecords),
    })

    expect(conn.noteUse.mock.calls[0]?.[0].error).toHaveLength(500)
  })

  /**
   * ⚠ A ZONE IT CANNOT SEE STILL COUNTS AS A WORKING CREDENTIAL. Listing zones
   * succeeded, so the connection is healthy and must not be left carrying a
   * stale error from a previous failure.
   */
  it("clears the stored error when the credential still works", async () => {
    const { publisher, conn } = publisherWith(
      writer({ zones: async () => [{ id: "a", name: "other.com" }] }),
    )

    await publisher.publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: domain(nsRecords),
    })

    expect(conn.noteUse).toHaveBeenCalledWith({
      tenantId: "t1",
      provider: "cloudflare",
      error: null,
    })
  })
})

describe("renewing the credential before using it", () => {
  /**
   * ⚠ RENEWED BEFORE THE FIRST CALL, NOT AFTER THE FIRST 401. Catching the
   * failure and retrying would work, but it makes every expired connection cost
   * a wasted round trip AND has to be repeated at every call site that touches
   * a credential. Doing it once, here, is the only place either happens.
   */
  it("hands the adapter the renewed credential, not the stored one", async () => {
    const seen: unknown[] = []
    const conn = connections()
    const publisher = dnsPublisher({
      connections: conn.store,
      log,
      writers: () =>
        writer({
          zones: async (credential) => {
            seen.push(credential)
            return [{ id: "z1", name: "example.com" }]
          },
          publish: async (credential, _z, records) => {
            seen.push(credential)
            return outcome({ created: [...records] })
          },
        }),
      renew: async () => ({ accessToken: "renewed-token" }),
    })

    await publisher.publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: domain(nsRecords),
    })

    expect(seen).toHaveLength(2)
    expect(
      seen.every((c) => (c as { accessToken: string }).accessToken === "renewed-token"),
    ).toBe(true)
  })

  /** ⚠ A PASTED TOKEN HAS NOTHING TO RENEW, and the default must not disturb it. */
  it("passes the stored credential straight through by default", async () => {
    let seen: unknown = null
    const publisher = dnsPublisher({
      connections: connections().store,
      log,
      writers: () =>
        writer({
          zones: async (credential) => {
            seen = credential
            return [{ id: "z1", name: "example.com" }]
          },
        }),
    })

    await publisher.publish({
      tenantId: "t1",
      provider: "cloudflare",
      domain: domain(nsRecords),
    })

    expect(seen).toEqual({ accessToken: "stub-not-a-real-token" })
  })
})
