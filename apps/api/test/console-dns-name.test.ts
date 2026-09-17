import { describe, expect, it } from "bun:test"
import { normaliseLookupName } from "../src/console/dns.js"

/**
 * What the DNS inspector is allowed to ask about.
 *
 * ⚠ THIS IS THE ONLY PLACE A NAME A CUSTOMER TYPED TURNS INTO A LOOKUP, and the
 * lookup runs inside the cluster with the pod's own resolver. Refusing the
 * internal suffixes is what stops "which provider hosts my domain?" from
 * doubling as "read the nameservers and TXT records of anything on the private
 * network". Every refusal below is a name that cannot belong to a customer.
 */
describe("normaliseLookupName", () => {
  it("accepts an ordinary public domain", () => {
    expect(normaliseLookupName("Example.COM")).toBe("example.com")
    expect(normaliseLookupName("mail.example.co.uk")).toBe("mail.example.co.uk")
  })

  it("strips a trailing root dot and surrounding space", () => {
    expect(normaliseLookupName("  example.com.  ")).toBe("example.com")
  })

  it("refuses anything that is not a bare hostname", () => {
    expect(normaliseLookupName("https://example.com")).toBeNull()
    expect(normaliseLookupName("bob@example.com")).toBeNull()
    expect(normaliseLookupName("example.com/path")).toBeNull()
    expect(normaliseLookupName("two words.com")).toBeNull()
    expect(normaliseLookupName("")).toBeNull()
    expect(normaliseLookupName("localhost")).toBeNull()
  })

  /**
   * ⚠ THE RECONNAISSANCE CASE. Each of these is a well-formed hostname that
   * resolves only from inside a private network — a Kubernetes service, a cloud
   * instance's private record, a reverse lookup of the metadata address. None
   * can be registered by anybody, so none is a domain somebody could be adding.
   */
  it("refuses names that only exist inside a private network", () => {
    for (const name of [
      "postgres.core.svc.cluster.local",
      "printer.local",
      "db.internal",
      "wiki.intranet",
      "vault.corp",
      "nas.home",
      "gateway.lan",
      "something.private",
      "254.169.254.169.in-addr.arpa",
      "0.0.0.0.ip6.arpa",
      "facebookcorewwwi.onion",
      "anything.test",
      "anything.invalid",
      "mail.example",
    ]) {
      expect(normaliseLookupName(name)).toBeNull()
    }
  })

  /**
   * ⚠ AND THE SUFFIX MATCH IS ON A LABEL BOUNDARY, WHICH IS THE WHOLE
   * CORRECTNESS OF IT. A substring check would refuse these four real domains
   * and tell their owners i10 cannot see their DNS.
   */
  it("still accepts public domains that merely contain a private word", () => {
    expect(normaliseLookupName("notlocal.com")).toBe("notlocal.com")
    expect(normaliseLookupName("my-internal.com")).toBe("my-internal.com")
    expect(normaliseLookupName("corp.example.com")).toBe("corp.example.com")
    expect(normaliseLookupName("localhost.example.com")).toBe("localhost.example.com")
  })
})
