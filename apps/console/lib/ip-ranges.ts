/**
 * The IP allowlist's ranges as text (#345): one address or CIDR range per
 * line. The API validates every entry (and says which one is wrong by
 * position); this only splits, trims and removes repeats, so what is sent is
 * what the person wrote.
 */

/** Entries separated by new lines, commas, semicolons or spaces. */
export function parseRanges(text: string): string[] {
  const seen = new Set<string>()
  const ranges: string[] = []
  for (const part of text.split(/[\s,;]+/)) {
    const entry = part.trim()
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    ranges.push(entry)
  }
  return ranges
}

export function rangesToText(ranges: readonly string[]): string {
  return ranges.join("\n")
}

/** Whether two lists are the same entries in the same order. */
export function sameRanges(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
