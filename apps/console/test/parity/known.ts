/**
 * ⚠ THE ONLY PLACE A SKELETON MAY BE EXCUSED FROM MATCHING ITS PAGE. A skeleton
 * is the page minus its data (docs/decisions/skeletons.md), so a mismatch is a
 * bug in the view, to be fixed in the view. This list exists for the rare
 * mismatch that cannot be fixed yet.
 *
 * Adding an entry takes two deliberate edits: here, and the expected list in
 * test/parity-known.test.tsx, which fails until the two agree. Each entry names
 * a route and a case that exist (that test checks), carries a reason a reviewer
 * would accept, and FAILS test/skeleton-parity the day the skeleton starts to
 * match, so it is deleted when it is fixed instead of outliving the bug. Never
 * for a new page.
 */
export interface KnownMismatch {
  /** The route as test/skeleton-coverage knows it: "/domains/[id]". */
  route: string
  /** `ParityCase.name` of one of that route's cases. */
  case: string
  /** Why it cannot match yet, and what would let it. */
  reason: string
}

export const KNOWN: KnownMismatch[] = []

/** The reason a case is excused, or undefined when it must match. */
export function knownReason(route: string, name: string): string | undefined {
  return KNOWN.find((k) => k.route === route && k.case === name)?.reason
}
