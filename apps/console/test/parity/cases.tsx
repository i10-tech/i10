import type { ParityView } from "./harness"

/**
 * Every console page with a loading.tsx, and the data states its skeleton must
 * match. A new page is added in one of the files below (test/skeleton-parity
 * fails, naming the route, until it is).
 *
 * ⚠ A FIXTURE TAKES A TAG, AND EVERY PIECE OF FREE TEXT CARRIES IT. The test
 * renders the same shape twice with two tags: if the pages differ outside a
 * Bone, data has leaked into the structure.
 */
const { LIST_VIEWS } = await import("./cases-lists")
const { PAGE_VIEWS } = await import("./cases-pages")
const { RECORD_VIEWS } = await import("./cases-records")
const { IDENTITY_VIEWS } = await import("./cases-identity")
const { MAIL_VIEWS } = await import("./cases-mail")

export const VIEWS: ParityView[] = [
  ...LIST_VIEWS,
  ...PAGE_VIEWS,
  ...RECORD_VIEWS,
  ...IDENTITY_VIEWS,
  ...MAIL_VIEWS,
]
