import { Resolver } from "node:dns/promises"
import { createSocket } from "node:dgram"

/**
 * Reading the NS records a domain's OWN nameservers publish for a delegated
 * subdomain.
 *
 * ⚠ AN ORDINARY RESOLVER CANNOT ANSWER THIS, AND THAT IS THE WHOLE REASON THIS
 * FILE EXISTS. Ask any recursive resolver for `mail.example.com NS` and it
 * FOLLOWS the delegation and returns the NS records from the zone at the far
 * end — ours. That tells us what we ourselves published, which was never in
 * question. What we need is what the CUSTOMER published, and that lives only in
 * the parent's referral: rcode NOERROR, an empty ANSWER section, and the NS
 * records in AUTHORITY, with no AA flag. `dns.resolveNs` reads the ANSWER
 * section, so it reports ENODATA for a perfectly good delegation.
 *
 * ⚠ AND IT IS WHAT LETS THE DELEGATION IDENTIFY THE ACCOUNT. Every delegating
 * customer used to be told to publish the same two nameservers, so nothing
 * reaching DNS said which workspace produced it — which is why there had to be
 * a separate challenge TXT record beside the delegation. Give each claim its
 * own nameserver hostnames and the delegation proves itself: only the holder of
 * `example.com`'s DNS can publish `mail.example.com NS <claim>.ns1.i10.tech`,
 * and the label says whose claim it is. Reading it back is this module.
 *
 * ⚠ THE QUERY IS SENT WITH RD=0, WHICH IS NOT COSMETIC. With recursion desired
 * a server that happens to also be a resolver would go and fetch the answer for
 * us — returning the child's own NS records again and defeating the entire
 * point. We want the referral, so we must ask not to be helped.
 */

/** The wire is UDP and bounded; nothing here waits on a slow nameserver. */
const DEFAULT_TIMEOUT = 3000

/** RFC 6891: advertise a larger buffer so a referral is not truncated. */
const EDNS_UDP_SIZE = 1232

const TYPE_NS = 2
const CLASS_IN = 1

export type ReferralResult =
  | { kind: "delegated"; nameservers: string[] }
  /** The parent answered, and publishes no delegation for that name. */
  | { kind: "undelegated" }
  /** We could not ask. NEVER the same as "they published nothing". */
  | { kind: "unreachable"; detail: string }

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, "").split(".")
  const out: Buffer[] = []
  for (const part of parts) {
    const label = Buffer.from(part, "ascii")
    if (label.length === 0 || label.length > 63) {
      throw new Error(`bad label in ${name}`)
    }
    out.push(Buffer.from([label.length]), label)
  }
  out.push(Buffer.from([0]))
  return Buffer.concat(out)
}

/**
 * ⚠ NAME COMPRESSION IS NOT OPTIONAL TO SUPPORT. A referral names the zone once
 * and then points at that offset for every NS record in it, so a decoder that
 * cannot follow a pointer reads the first record and garbage after it.
 *
 * ⚠ AND THE JUMP BUDGET IS THE DEFENCE AGAINST A MALICIOUS ANSWER. A pointer
 * that points at itself, or two that point at each other, is a packet that
 * hangs this process for ever — and the packet comes from a nameserver chosen
 * by the customer's own DNS configuration.
 */
function decodeName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = []
  let position = offset
  let next = -1
  let jumps = 0

  for (;;) {
    if (position >= buf.length) throw new Error("name ran past the packet")
    const length = buf[position]!

    if (length === 0) {
      position += 1
      break
    }

    if ((length & 0xc0) === 0xc0) {
      if (position + 1 >= buf.length) throw new Error("truncated compression pointer")
      if (next === -1) next = position + 2
      position = ((length & 0x3f) << 8) | buf[position + 1]!
      jumps += 1
      if (jumps > 32) throw new Error("compression pointer loop")
      continue
    }

    if ((length & 0xc0) !== 0) throw new Error("unknown label type")
    const end = position + 1 + length
    if (end > buf.length) throw new Error("label ran past the packet")
    labels.push(buf.subarray(position + 1, end).toString("ascii"))
    position = end
  }

  return { name: labels.join("."), next: next === -1 ? position : next }
}

interface Parsed {
  rcode: number
  truncated: boolean
  /** NS records from ANSWER and AUTHORITY, whichever section they arrived in. */
  nameservers: string[]
}

/**
 * ⚠ BOTH SECTIONS ARE READ, AND THAT IS DELIBERATE ROBUSTNESS RATHER THAN
 * SLOPPINESS. A referral puts the NS records in AUTHORITY, which is the case
 * this exists for — but a server that is authoritative for the child as well as
 * the parent answers from ANSWER with AA set, and a handful of hosted DNS
 * products do exactly that for a subdomain they also host. Reading only one
 * section would report "undelegated" for a delegation that plainly exists.
 */
export function parseReferral(buf: Buffer, question: string): Parsed {
  if (buf.length < 12) throw new Error("packet too short for a DNS header")

  const flags = buf.readUInt16BE(2)
  const rcode = flags & 0x0f
  const truncated = (flags & 0x0200) !== 0

  const counts = {
    question: buf.readUInt16BE(4),
    answer: buf.readUInt16BE(6),
    authority: buf.readUInt16BE(8),
  }

  let offset = 12
  for (let i = 0; i < counts.question; i += 1) {
    offset = decodeName(buf, offset).next + 4
  }

  const wanted = question.replace(/\.$/, "").toLowerCase()
  const nameservers: string[] = []

  for (let i = 0; i < counts.answer + counts.authority; i += 1) {
    if (offset >= buf.length) break
    const owner = decodeName(buf, offset)
    offset = owner.next

    if (offset + 10 > buf.length) break
    const type = buf.readUInt16BE(offset)
    const rdLength = buf.readUInt16BE(offset + 8)
    const rdStart = offset + 10
    offset = rdStart + rdLength

    if (type !== TYPE_NS) continue
    // ⚠ ONLY RECORDS FOR THE NAME WE ASKED ABOUT. An authority section can also
    // carry the parent's own SOA, and some servers add unrelated NS records.
    if (owner.name.replace(/\.$/, "").toLowerCase() !== wanted) continue

    nameservers.push(decodeName(buf, rdStart).name.replace(/\.$/, "").toLowerCase())
  }

  return { rcode, truncated, nameservers }
}

function buildQuery(name: string, id: number): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  // ⚠ FLAGS ZERO: a standard query with RECURSION NOT DESIRED. See the note on
  // the module; RD=1 here would hand us the child's own answer.
  header.writeUInt16BE(0, 2)
  header.writeUInt16BE(1, 4) // QDCOUNT: one question
  header.writeUInt16BE(1, 10) // ARCOUNT: the OPT record below

  const question = Buffer.concat([
    encodeName(name),
    (() => {
      const tail = Buffer.alloc(4)
      tail.writeUInt16BE(TYPE_NS, 0)
      tail.writeUInt16BE(CLASS_IN, 2)
      return tail
    })(),
  ])

  // EDNS0 OPT: root name, type 41, class = advertised UDP payload size.
  const opt = Buffer.alloc(11)
  opt.writeUInt8(0, 0)
  opt.writeUInt16BE(41, 1)
  opt.writeUInt16BE(EDNS_UDP_SIZE, 3)
  opt.writeUInt32BE(0, 5)
  opt.writeUInt16BE(0, 9)

  return Buffer.concat([header, question, opt])
}

/** One UDP question to one server. Resolves with the raw response. */
export function askServer(
  address: string,
  name: string,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(address.includes(":") ? "udp6" : "udp4")
    const id = Math.floor(Math.random() * 0xffff)
    const query = buildQuery(name, id)

    const done = (error: Error | null, answer?: Buffer) => {
      clearTimeout(timer)
      socket.removeAllListeners()
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      if (error) reject(error)
      else resolve(answer!)
    }

    const timer = setTimeout(() => done(new Error("timed out")), timeoutMs)

    socket.on("error", (error) => done(error))
    socket.on("message", (message) => {
      // ⚠ THE ID IS CHECKED. An off-path answer with the wrong id is the oldest
      // spoofing trick there is, and this socket is open to the internet.
      if (message.length >= 2 && message.readUInt16BE(0) === id) done(null, message)
    })

    socket.send(query, 53, address, (error) => {
      if (error) done(error)
    })
  })
}

export interface ReferralOptions {
  timeoutMs?: number
  /** Overridden by tests. Production asks the real parent. */
  ask?: (address: string, name: string, timeoutMs: number) => Promise<Buffer>
  /** Overridden by tests. Finds the parent's nameserver addresses. */
  parentAddresses?: (parent: string) => Promise<string[]>
}

async function addressesOfParent(parent: string, timeoutMs: number): Promise<string[]> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 2 })
  const hosts = await resolver.resolveNs(parent)

  const found: string[] = []
  for (const host of hosts.slice(0, 3)) {
    try {
      found.push(...(await resolver.resolve4(host)))
    } catch {
      // ⚠ ONE UNRESOLVABLE NAMESERVER IS NOT A FAILURE. A zone with four
      // nameservers where one has lost its A record still serves perfectly.
      continue
    }
  }
  return found
}

/**
 * What `parent` publishes as the delegation for `child`.
 *
 * ⚠ `undelegated` AND `unreachable` ARE DIFFERENT ANSWERS AND MUST STAY THAT
 * WAY, for the same reason they are kept apart everywhere else in this feature:
 * a customer who has not published the records yet is not a nameserver that
 * timed out, and acting on the second as though it were the first is how a DNS
 * outage turns into customers losing domains.
 */
export async function readDelegation(
  parent: string,
  child: string,
  options: ReferralOptions = {},
): Promise<ReferralResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
  const ask = options.ask ?? askServer

  let addresses: string[]
  try {
    addresses = await (
      options.parentAddresses ?? ((p: string) => addressesOfParent(p, timeoutMs))
    )(parent)
  } catch (error) {
    return { kind: "unreachable", detail: `parent nameservers: ${String(error)}` }
  }
  if (addresses.length === 0) {
    return { kind: "unreachable", detail: "the parent has no reachable nameserver" }
  }

  let lastError = "no server answered"

  for (const address of addresses.slice(0, 3)) {
    let parsed: Parsed
    try {
      parsed = parseReferral(await ask(address, child, timeoutMs), child)
    } catch (error) {
      lastError = String(error)
      continue
    }

    // ⚠ TRUNCATION IS NOT AN ANSWER EITHER. We asked with EDNS0, so this is
    // rare; reading a partial authority section would under-report the
    // delegation, which reads as "they published nothing".
    if (parsed.truncated) {
      lastError = "the referral was truncated"
      continue
    }

    // NXDOMAIN and NOERROR both mean the parent answered. Anything else —
    // SERVFAIL, REFUSED — means this server could not or would not tell us.
    if (parsed.rcode !== 0 && parsed.rcode !== 3) {
      lastError = `rcode ${parsed.rcode}`
      continue
    }

    return parsed.nameservers.length > 0
      ? { kind: "delegated", nameservers: parsed.nameservers }
      : { kind: "undelegated" }
  }

  return { kind: "unreachable", detail: lastError }
}
