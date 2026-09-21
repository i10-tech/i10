import { describe, expect, it } from "bun:test"
import { proveDelegation } from "../src/domains/ownership.js"
import type { DelegationProbe } from "../src/domains/ownership.js"

/**
 * A domain whose records name an older claim.
 *
 * ⚠ `delegation_token` IS GENERATED PER ROW, so deleting a domain and adding it
 * again issues a NEW claim and every NS record the customer already published
 * names the OLD one. Those records resolve, they point at our nameservers, and
 * they look exactly right in a DNS panel — and until this distinction existed
 * the check reported them as `absent`, which tells somebody to go and fix DNS
 * that is present and correct.
 */

const NS = ["ns1.i10.tech", "ns2.i10.tech"]
const MINE = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"
const OLD = "ffffffffffffffffffffffffffffffff"

const delegatingTo =
  (claim: string): DelegationProbe =>
  async () => ({
    kind: "delegated" as const,
    nameservers: [`${claim}.ns1.i10.tech`, `${claim}.ns2.i10.tech`],
  })

describe("proving a delegation whose claim has moved on", () => {
  it("proves when the parent names this row's own claim", async () => {
    const out = await proveDelegation(delegatingTo(MINE), "example.com", MINE, NS)
    expect(out.proven).toBe(true)
  })

  it("reports superseded when the parent names OUR nameservers under another claim", async () => {
    const out = await proveDelegation(delegatingTo(OLD), "example.com", MINE, NS)
    expect(out).toEqual({ proven: false, reason: "superseded" })
  })

  /**
   * ⚠ DELEGATED SOMEWHERE ELSE ENTIRELY IS STILL `absent`. `superseded` is a
   * claim about OUR nameservers specifically; widening it to any delegation
   * would tell a customer who pointed their domain at a different provider that
   * they merely have an old i10 record.
   */
  it("still reports absent when the delegation is to somebody else", async () => {
    const probe: DelegationProbe = async () => ({
      kind: "delegated" as const,
      nameservers: ["ns1.example-dns.net", "ns2.example-dns.net"],
    })
    const out = await proveDelegation(probe, "example.com", MINE, NS)
    expect(out).toEqual({ proven: false, reason: "absent" })
  })

  /** ⚠ AND AN UNREACHABLE LOOKUP IS STILL NOT AN ANSWER ABOUT ANYTHING. */
  it("still reports unreachable when nothing answered", async () => {
    const probe: DelegationProbe = async () => ({
      kind: "unreachable" as const,
      detail: "timed out",
    })
    const out = await proveDelegation(probe, "example.com", MINE, NS)
    expect(out).toEqual({ proven: false, reason: "unreachable" })
  })
})
