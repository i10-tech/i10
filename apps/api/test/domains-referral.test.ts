import { describe, expect, it } from "bun:test"
import { parseReferral, readDelegation } from "../src/domains/referral.js"

/**
 * Reading what a domain's OWN nameservers say about a delegated subdomain.
 *
 * ⚠ THIS IS HAND-ROLLED WIRE FORMAT, PARSING BYTES FROM A SERVER THE CUSTOMER
 * CHOSE. That is the argument for testing it hard: a packet arriving here comes
 * from whatever nameserver a customer's DNS configuration points at, which is
 * not a trusted input. A compression pointer that points at itself is four
 * bytes and hangs the process; a length byte past the end of the buffer is a
 * crash in a request somebody is waiting on.
 *
 * ⚠ AND EVERY WRONG ANSWER HERE IS A DOMAIN GRANTED OR REFUSED INCORRECTLY.
 * Under-reading the authority section says "they published nothing" about a
 * customer who published everything; over-reading it hands a delegation to
 * whoever can get a stray NS record into a packet.
 */

const name = (value: string) => {
  const parts = value.split(".").filter(Boolean)
  return Buffer.concat([
    ...parts.map((p) =>
      Buffer.concat([Buffer.from([p.length]), Buffer.from(p, "ascii")]),
    ),
    Buffer.from([0]),
  ])
}

/** A pointer to an absolute offset, as a real server emits for a repeated name. */
const pointer = (offset: number) => Buffer.from([0xc0 | (offset >> 8), offset & 0xff])

interface Rr {
  owner: Buffer
  type?: number
  rdata: Buffer
}

function packet({
  rcode = 0,
  truncated = false,
  question = "mail.example.com",
  answers = [],
  authority = [],
}: {
  rcode?: number
  truncated?: boolean
  question?: string
  answers?: Rr[]
  authority?: Rr[]
}) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x1234, 0)
  header.writeUInt16BE((truncated ? 0x0200 : 0) | rcode, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(answers.length, 6)
  header.writeUInt16BE(authority.length, 8)

  const q = Buffer.concat([name(question), Buffer.from([0, 2, 0, 1])])

  const encode = (rr: Rr) => {
    const fixed = Buffer.alloc(10)
    fixed.writeUInt16BE(rr.type ?? 2, 0)
    fixed.writeUInt16BE(1, 2)
    fixed.writeUInt32BE(300, 4)
    fixed.writeUInt16BE(rr.rdata.length, 8)
    return Buffer.concat([rr.owner, fixed, rr.rdata])
  }

  return Buffer.concat([header, q, ...answers.map(encode), ...authority.map(encode)])
}

describe("reading the delegation out of a referral", () => {
  /**
   * ⚠ THE AUTHORITY SECTION IS WHERE A REFERRAL PUTS IT, and reading only the
   * answer section — which is what `dns.resolveNs` does — reports ENODATA for a
   * delegation that plainly exists.
   */
  it("reads NS records out of the authority section", () => {
    const parsed = parseReferral(
      packet({
        authority: [
          { owner: name("mail.example.com"), rdata: name("a7f3c9d2.ns1.i10.tech") },
          { owner: name("mail.example.com"), rdata: name("a7f3c9d2.ns2.i10.tech") },
        ],
      }),
      "mail.example.com",
    )

    expect(parsed.nameservers).toEqual([
      "a7f3c9d2.ns1.i10.tech",
      "a7f3c9d2.ns2.i10.tech",
    ])
  })

  /**
   * ⚠ AND ALSO OUT OF THE ANSWER SECTION, because a server authoritative for
   * the child as well as the parent answers with AA set and fills ANSWER
   * instead. Several hosted DNS products do this for a subdomain they also
   * host, and reading one section only would call that "undelegated".
   */
  it("reads them from the answer section too", () => {
    const parsed = parseReferral(
      packet({
        answers: [{ owner: name("mail.example.com"), rdata: name("ns1.i10.tech") }],
      }),
      "mail.example.com",
    )
    expect(parsed.nameservers).toEqual(["ns1.i10.tech"])
  })

  /**
   * ⚠ COMPRESSION IS NOT OPTIONAL TO SUPPORT. A real referral names the zone
   * once and points at that offset for every record after it — the root's
   * referral for `com` is thirteen records and almost entirely pointers.
   */
  it("follows compression pointers", () => {
    // The question's QNAME starts at offset 12, so a pointer there is the
    // delegated name — exactly what a server emits.
    const parsed = parseReferral(
      packet({
        authority: [
          { owner: pointer(12), rdata: name("a7f3c9d2.ns1.i10.tech") },
          { owner: pointer(12), rdata: name("a7f3c9d2.ns2.i10.tech") },
        ],
      }),
      "mail.example.com",
    )
    expect(parsed.nameservers).toHaveLength(2)
  })

  /**
   * ⚠ ONLY RECORDS FOR THE NAME WE ASKED ABOUT. An authority section legitimately
   * carries the parent's own SOA, and a hostile one can carry NS records for
   * anything at all. Accepting those would let a packet hand us a delegation
   * for a name nobody delegated.
   */
  it("ignores NS records for a different name", () => {
    const parsed = parseReferral(
      packet({
        authority: [
          { owner: name("elsewhere.example.com"), rdata: name("evil.ns.example") },
          { owner: name("mail.example.com"), rdata: name("ns1.i10.tech") },
        ],
      }),
      "mail.example.com",
    )
    expect(parsed.nameservers).toEqual(["ns1.i10.tech"])
  })

  it("ignores records that are not NS", () => {
    const soa = Buffer.concat([
      name("ns.example.com"),
      name("host.example.com"),
      Buffer.alloc(20),
    ])
    const parsed = parseReferral(
      packet({ authority: [{ owner: name("example.com"), type: 6, rdata: soa }] }),
      "mail.example.com",
    )
    expect(parsed.nameservers).toEqual([])
  })

  it("reports the rcode and the truncation bit", () => {
    expect(parseReferral(packet({ rcode: 2 }), "mail.example.com").rcode).toBe(2)
    expect(
      parseReferral(packet({ truncated: true }), "mail.example.com").truncated,
    ).toBe(true)
  })
})

describe("a packet that is trying to hurt us", () => {
  /** ⚠ FOUR BYTES THAT WOULD OTHERWISE SPIN FOR EVER. */
  it("refuses a compression pointer loop instead of hanging", () => {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(1, 4)
    header.writeUInt16BE(1, 8)
    const q = Buffer.concat([name("mail.example.com"), Buffer.from([0, 2, 0, 1])])
    // An owner name that points at itself.
    const selfPointer = pointer(header.length + q.length)
    const fixed = Buffer.alloc(10)
    fixed.writeUInt16BE(2, 0)
    fixed.writeUInt16BE(1, 2)
    fixed.writeUInt16BE(2, 8)

    expect(() =>
      parseReferral(
        Buffer.concat([header, q, selfPointer, fixed, pointer(12)]),
        "mail.example.com",
      ),
    ).toThrow(/loop/)
  })

  it("refuses a label that runs past the end of the packet", () => {
    const header = Buffer.alloc(12)
    header.writeUInt16BE(1, 4)
    // A length byte claiming 60 bytes of label with nothing behind it.
    expect(() =>
      parseReferral(Buffer.concat([header, Buffer.from([60, 0x61, 0x61])]), "x"),
    ).toThrow(/past the packet/)
  })

  it("refuses a packet too short to be a DNS message", () => {
    expect(() => parseReferral(Buffer.alloc(4), "x")).toThrow(/too short/)
  })
})

describe("asking the parent", () => {
  const parentAddresses = async () => ["192.0.2.1", "192.0.2.2"]

  it("reports a delegation the parent publishes", async () => {
    const result = await readDelegation("example.com", "mail.example.com", {
      parentAddresses,
      ask: async () =>
        packet({
          authority: [
            { owner: name("mail.example.com"), rdata: name("a7f3c9d2.ns1.i10.tech") },
          ],
        }),
    })
    expect(result).toEqual({
      kind: "delegated",
      nameservers: ["a7f3c9d2.ns1.i10.tech"],
    })
  })

  it("reports an absent delegation as undelegated, not as a failure", async () => {
    const result = await readDelegation("example.com", "mail.example.com", {
      parentAddresses,
      ask: async () => packet({}),
    })
    expect(result).toEqual({ kind: "undelegated" })
  })

  /** ⚠ NXDOMAIN IS AN ANSWER: the parent is telling us the name does not exist. */
  it("treats NXDOMAIN as an answer", async () => {
    const result = await readDelegation("example.com", "mail.example.com", {
      parentAddresses,
      ask: async () => packet({ rcode: 3 }),
    })
    expect(result.kind).toBe("undelegated")
  })

  /**
   * ⚠ AND SERVFAIL IS NOT. "Could not ask" must never be reported as "they
   * published nothing" — everything downstream of this treats the second as
   * grounds to take a domain away.
   */
  it("treats SERVFAIL as unreachable rather than as undelegated", async () => {
    const result = await readDelegation("example.com", "mail.example.com", {
      parentAddresses,
      ask: async () => packet({ rcode: 2 }),
    })
    expect(result.kind).toBe("unreachable")
  })

  it("treats a truncated referral as unreachable", async () => {
    const result = await readDelegation("example.com", "mail.example.com", {
      parentAddresses,
      ask: async () => packet({ truncated: true }),
    })
    expect(result.kind).toBe("unreachable")
  })

  /** ⚠ ONE DEAD NAMESERVER IS NOT A DEAD ZONE. Resolvers try the next one. */
  it("moves on to the parent's next nameserver", async () => {
    let asked = 0
    const result = await readDelegation("example.com", "mail.example.com", {
      parentAddresses,
      ask: async () => {
        asked += 1
        if (asked === 1) throw new Error("timed out")
        return packet({
          authority: [{ owner: name("mail.example.com"), rdata: name("ns1.i10.tech") }],
        })
      },
    })
    expect(asked).toBe(2)
    expect(result).toEqual({ kind: "delegated", nameservers: ["ns1.i10.tech"] })
  })

  it("is unreachable when the parent has no nameserver we can reach", async () => {
    const result = await readDelegation("example.com", "mail.example.com", {
      parentAddresses: async () => [],
      ask: async () => packet({}),
    })
    expect(result.kind).toBe("unreachable")
  })
})
