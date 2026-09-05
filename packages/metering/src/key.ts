/**
 * How a meter is addressed.
 *
 * ⚠ THE SHARD IS IN THE KEY FROM THE FIRST DAY, AND THAT IS THE ENTIRE REASON
 * THIS FILE EXISTS. Nothing shards yet — every caller passes 0 and the Postgres
 * adapter stores 0 — but the shape of an identifier is the one thing that
 * cannot be changed quietly later. A key minted as `tenant:feature` and widened
 * to `tenant:feature:shard` afterwards means every stored row, every Durable
 * Object name and every dashboard query has to be migrated at once, on the day
 * a single tenant starts hammering us: the worst day to be doing a rename.
 *
 * ⚠ AND IT IS ALSO WHY THERE IS NO GLOBAL COUNTER ANYWHERE IN THIS PACKAGE.
 * Every primitive is keyed by `(tenantId, featureId)`, including anything we
 * might want for internal statistics. A global counter is exactly the shared
 * mutable state that turns out to be unshardable, and it is always added "just
 * for metrics".
 */

export interface MeterKey {
  tenantId: string
  featureId: string
  /**
   * Which slice of the meter this is. Always 0 today.
   *
   * ⚠ WHEN THIS IS NOT 0, THE ALLOWANCE IS DIVIDED, NOT SHARED. A shard holds
   * its own fraction of the budget and its own count; it never reads its
   * siblings, because a read across shards is the coordination the split was
   * bought to avoid. That makes the gate slightly wrong near the limit when
   * traffic lands unevenly — which is the trade already committed to in
   * docs/decisions/metering.md, and the reason the ledger is a separate tier.
   */
  shard: number
}

/**
 * ⚠ `:` IS RESERVED, AND THAT IS CHECKED RATHER THAN DOCUMENTED. A feature id
 * containing a separator produces a key that parses back to something else —
 * `emails:eu` on tenant `t` reads as feature `emails` on shard `eu` — and the
 * failure is silent: usage lands under a meter nobody queries.
 */
const SEPARATOR = ":"

/** The string form: `tenantId:featureId:shard`. Stable; treat it as a name. */
export function meterKey(tenantId: string, featureId: string, shard = 0): string {
  assertPart("tenantId", tenantId)
  assertPart("featureId", featureId)
  assertShard(shard)
  return [tenantId, featureId, String(shard)].join(SEPARATOR)
}

/** Convenience for the same three values as an object. */
export function meterKeyOf(tenantId: string, featureId: string, shard = 0): MeterKey {
  assertPart("tenantId", tenantId)
  assertPart("featureId", featureId)
  assertShard(shard)
  return { tenantId, featureId, shard }
}

/** The string form of a key that is already an object. */
export const formatMeterKey = (key: MeterKey): string =>
  meterKey(key.tenantId, key.featureId, key.shard)

/**
 * The inverse of `meterKey`.
 *
 * ⚠ IT EXISTS FOR THE DURABLE OBJECT, WHICH IS HANDED ITS OWN NAME AND NOTHING
 * ELSE. `idFromName(key)` gives the object an identity but no arguments, so the
 * only way it can know which tenant and feature it is counting is to read it
 * back out of the name it was addressed by.
 */
export function parseMeterKey(key: string): MeterKey {
  const parts = key.split(SEPARATOR)
  if (parts.length !== 3) {
    throw new RangeError(`not a meter key: ${key}`)
  }

  const [tenantId, featureId, rawShard] = parts as [string, string, string]
  const shard = Number(rawShard)

  assertPart("tenantId", tenantId)
  assertPart("featureId", featureId)
  assertShard(shard)

  return { tenantId, featureId, shard }
}

function assertPart(name: string, value: string): void {
  if (value.length === 0) {
    throw new RangeError(`${name} must not be empty`)
  }
  if (value.includes(SEPARATOR)) {
    throw new RangeError(`${name} must not contain ${SEPARATOR}, got ${value}`)
  }
}

function assertShard(shard: number): void {
  if (!Number.isInteger(shard) || shard < 0) {
    throw new RangeError(`shard must be a non-negative integer, got ${shard}`)
  }
}
