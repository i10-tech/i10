/**
 * i10's metering core: what an allowance is, when it refills, and whether a
 * request fits inside it.
 *
 * ⚠ NOTHING HERE PERFORMS I/O, AND NOTHING HERE READS A CLOCK. Storage arrives
 * through a port and the current time arrives as an argument, which is what
 * lets the same code answer a quota check inside `POST /emails` on the API
 * server and inside a Durable Object at the edge — see docs/decisions/metering.md.
 *
 * Some of the semantics are derived from Autumn (Apache-2.0). See NOTICE for
 * what was taken and, more importantly, where this deliberately differs.
 */

export { draw, remainingOf } from "./balance.js"
export type { Allowance, DrawInput, DrawOutcome } from "./balance.js"

export { resetsAt, windowFor } from "./interval.js"
export type { ResetInterval, ResetWindow, WindowInput } from "./interval.js"

export { formatMeterKey, meterKey, meterKeyOf, parseMeterKey } from "./key.js"
export type { MeterKey } from "./key.js"

export { entitlementFor } from "./plan.js"
export type {
  Assignment,
  ConsumableEntitlement,
  ContinuousEntitlement,
  Entitlement,
  OveragePolicy,
  Plan,
  PlanSource,
} from "./plan.js"

export type {
  AssignmentStore,
  LevelStore,
  RecordResult,
  UsageEvent,
  UsageStore,
} from "./ports.js"

export { createMeter } from "./meter.js"
export type {
  CheckInput,
  CheckOutcome,
  Meter,
  MeterDeps,
  RecordInput,
} from "./meter.js"
