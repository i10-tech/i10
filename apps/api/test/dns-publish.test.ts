import { describe, expect, it, mock } from "bun:test"
import type { Domain } from "@repo/contracts"
import { dnsPublisher } from "../src/dns/publish.js"
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
   * ⚠ `"Auto"` BECOMES 300, MATCHING THE ZONES WE SERVE OURSELVES. A short TTL
   * matters most in exactly this window: somebody is watching for the record to
   * appear, and an hour-long negative cache is the difference between "it
   * worked" and "it did nothing".
   */
  it("turns an Auto TTL into 300 seconds and keeps a priority", async () => {
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

    expect(sent.map((r) => r.ttl)).toEqual([300, 300, 600])
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
