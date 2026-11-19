/**
 * Every host the generator may write into a mail is reserved or clearly
 * fictional, so nothing in the set can point at a real third party, and the
 * link a judge sees can never resolve anywhere.
 *
 * - `.example`, `.test`, `.invalid` are reserved top-level domains (RFC 2606,
 *   RFC 6761).
 * - `example.com`, `example.net` and `example.org` and everything under them
 *   are reserved for documentation (RFC 2606).
 */

const RESERVED_TLDS = ["example", "test", "invalid"] as const
const RESERVED_SECOND_LEVEL = ["example.com", "example.net", "example.org"] as const

export function isReservedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "")
  if (h === "") return false
  if (RESERVED_SECOND_LEVEL.some((d) => h === d || h.endsWith(`.${d}`))) return true
  const tld = h.slice(h.lastIndexOf(".") + 1)
  return (RESERVED_TLDS as readonly string[]).includes(tld)
}

/** Hosts of every http(s) and mailto link, and of every address, in a text. */
export function hostsIn(text: string): string[] {
  const hosts: string[] = []
  for (const m of text.matchAll(/\bhttps?:\/\/([^\s/?#"'<>)\]]+)/gi)) {
    const authority = m[1] ?? ""
    hosts.push(authority.replace(/^.*@/, "").replace(/:\d+$/, ""))
  }
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    hosts.push(m[1] ?? "")
  }
  return hosts
}
