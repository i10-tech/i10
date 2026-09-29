import type { StoredVersion } from "@repo/templates"

/**
 * Template versions the send path has read, kept in this process (#238).
 *
 * ⚠ SAFE TO KEEP FOREVER BECAUSE A VERSION NEVER CHANGES. `template_versions`
 * rows are written once; what moves is which one is live, and that is never
 * cached here - every send still asks Postgres which version its reference
 * means, so a promote takes effect on the next send on every pod.
 *
 * ⚠ KEYED BY TENANT AND VERSION ID, NOT BY ID ALONE. Ids reach this cache only
 * from a tenant-scoped query, so a cross-tenant hit is already impossible; the
 * tenant in the key keeps it impossible if that ever stops being true.
 *
 * Bounded by an estimate of the bytes held, and evicted least recently used.
 */
export class VersionCache {
  private readonly entries = new Map<
    string,
    { version: StoredVersion; bytes: number }
  >()
  private held = 0

  constructor(private readonly maxBytes = 32 * 1024 * 1024) {}

  get(tenantId: string, versionId: string): StoredVersion | undefined {
    const key = `${tenantId}:${versionId}`
    const hit = this.entries.get(key)
    if (!hit) return undefined
    // Re-inserted so Map order is recency order.
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit.version
  }

  set(tenantId: string, version: StoredVersion): void {
    const key = `${tenantId}:${version.id}`
    const bytes = sizeOf(version)
    if (bytes > this.maxBytes / 4) return // one huge version must not flush the rest
    const old = this.entries.get(key)
    if (old) {
      this.held -= old.bytes
      this.entries.delete(key)
    }
    this.entries.set(key, { version, bytes })
    this.held += bytes
    for (const [k, entry] of this.entries) {
      if (this.held <= this.maxBytes) break
      this.entries.delete(k)
      this.held -= entry.bytes
    }
  }

  get size(): number {
    return this.entries.size
  }
}

/** UTF-16 code units, doubled: a JS string's rough cost in memory. */
function sizeOf(v: StoredVersion): number {
  let n = 256
  for (const s of [v.html, v.text, v.subject]) n += (s?.length ?? 0) * 2
  for (const variable of v.variables)
    n += (variable.path.length + variable.preview.length) * 2
  return n
}
