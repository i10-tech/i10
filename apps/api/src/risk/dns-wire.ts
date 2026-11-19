/**
 * The little of DNS's wire format that a DNS-over-HTTPS lookup needs (RFC 1035,
 * RFC 8484): one question out, a header, the answers and the authority count
 * back.
 *
 * ⚠ WIRE FORMAT, NOT THE JSON API. Quad9 answers only `application/dns-message`;
 * Cloudflare's JSON form carries no authority count and, for a block, no hint
 * beyond the address. One codec serves both resolvers.
 */
export const TYPE_A = 1

export interface DnsAnswer {
  type: number
  /** Dotted quad for an A record; null for every other type. */
  address: string | null
}

export interface DnsMessage {
  /** 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN, 5 REFUSED. */
  rcode: number
  truncated: boolean
  /** The question as the server echoed it. */
  question: { name: string; type: number } | null
  answers: DnsAnswer[]
  /** Records in the authority section: an honest NXDOMAIN carries the zone's SOA. */
  authority: number
}

/** A query for `name` (already validated: ASCII labels of 1-63 characters). */
export function encodeQuery(name: string, type: number): Uint8Array {
  const out: number[] = [
    // id 0, as RFC 8484 asks for a cacheable GET; flags: recursion desired
    0, 0, 0x01, 0x00,
    // one question, no answers, no authority, one additional (the OPT below)
    0, 1, 0, 0, 0, 0, 0, 1,
  ]
  for (const label of name.split(".")) {
    out.push(label.length)
    for (let i = 0; i < label.length; i++) out.push(label.charCodeAt(i))
  }
  out.push(0, type >> 8, type & 0xff, 0, 1)
  // EDNS0 OPT, advertising 1232 bytes: without it some resolvers answer short
  out.push(0, 0, 41, 0x04, 0xd0, 0, 0, 0, 0, 0, 0)
  return Uint8Array.from(out)
}

class Reader {
  readonly view: DataView
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  u16(at: number) {
    if (at + 2 > this.bytes.length) throw new Error("truncated DNS message")
    return this.view.getUint16(at)
  }
  /** The name at `at`, and the offset just past it in the message. */
  name(at: number): [string, number] {
    const labels: string[] = []
    let p = at
    let next = -1
    for (let hops = 0; hops < 128; hops++) {
      if (p >= this.bytes.length) throw new Error("truncated DNS message")
      const len = this.bytes[p]!
      if (len === 0) return [labels.join("."), next === -1 ? p + 1 : next]
      if ((len & 0xc0) === 0xc0) {
        if (next === -1) next = p + 2
        p = this.u16(p) & 0x3fff
        continue
      }
      if (len > 63 || p + 1 + len > this.bytes.length)
        throw new Error("bad label in DNS message")
      labels.push(String.fromCharCode(...this.bytes.subarray(p + 1, p + 1 + len)))
      p += 1 + len
    }
    throw new Error("DNS name does not end")
  }
}

export function decodeMessage(bytes: Uint8Array): DnsMessage {
  if (bytes.length < 12) throw new Error("truncated DNS message")
  const r = new Reader(bytes)
  const flags = r.u16(2)
  if (!(flags & 0x8000)) throw new Error("not a DNS response")
  const questions = r.u16(4)
  const answers = r.u16(6)
  const authority = r.u16(8)

  let at = 12
  let question: DnsMessage["question"] = null
  for (let i = 0; i < questions; i++) {
    const [name, end] = r.name(at)
    if (i === 0) question = { name: name.toLowerCase(), type: r.u16(end) }
    at = end + 4
  }
  const found: DnsAnswer[] = []
  for (let i = 0; i < answers; i++) {
    const [, end] = r.name(at)
    const type = r.u16(end)
    const length = r.u16(end + 8)
    const data = end + 10
    if (data + length > bytes.length) throw new Error("truncated DNS message")
    found.push({
      type,
      address:
        type === TYPE_A && length === 4
          ? [...bytes.subarray(data, data + 4)].join(".")
          : null,
    })
    at = data + length
  }
  return {
    rcode: flags & 0x0f,
    truncated: Boolean(flags & 0x0200),
    question,
    answers: found,
    authority,
  }
}
