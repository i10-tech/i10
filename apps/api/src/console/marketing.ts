import type { Database } from "../db/client.js"
import { campaignsStore } from "./marketing/campaigns.js"
import { contactsStore } from "./marketing/contacts.js"
import { segmentsStore } from "./marketing/segments.js"
import type { MarketingStore } from "./marketing/types.js"

export type {
  BroadcastInput,
  BroadcastRow,
  BroadcastStats,
  BroadcastSummary,
  ContactRow,
  ImportResult,
  MarketingStore,
  PropertyRow,
  SegmentRow,
  TemplateRow,
  TemplateSummary,
  TopicRow,
} from "./marketing/types.js"
export { PROPERTY_KEY, parseContactCsv } from "./marketing/csv.js"

/**
 * Everything behind the console's Contacts, Segments, Topics, Broadcasts and
 * Templates screens, as one object.
 *
 * ⚠ ONE INTERFACE, THREE MODULES, AND THE SEAM IS DELIBERATELY NOT AN
 * ABSTRACTION. `ConsoleDeps.marketing` is a single store because every route
 * that touches this data touches two halves of it — adding contacts to a
 * segment, counting a topic's subscribers, sending a broadcast to a segment —
 * and splitting the DEPENDENCY would mean four objects threaded through the
 * wiring to express a boundary that does not exist at runtime. What is split is
 * the SOURCE, because thirty-one methods in one file is a file nobody reads to
 * the end of.
 *
 * ⚠ AND THE COMPOSITION IS A SPREAD RATHER THAN A CLASS HIERARCHY. Each slice
 * returns a `Pick<MarketingStore, …>` of exactly the methods it implements, so
 * TypeScript checks the union against the interface here: a method moved
 * between modules and forgotten, or implemented twice, does not compile.
 */
export function marketingStore(db: Database): MarketingStore {
  return {
    ...contactsStore(db),
    ...segmentsStore(db),
    ...campaignsStore(db),
  }
}
