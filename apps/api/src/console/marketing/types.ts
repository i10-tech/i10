import type { Page } from "../queries.js"

/**
 * Contacts, segments, topics, broadcasts and templates.
 *
 * ⚠ A CONTACT IS GLOBAL TO A TENANT AND UNIQUE BY ADDRESS. Every operation here
 * assumes that, and the schema enforces it. The naive alternative — a contact
 * row per list — makes unsubscribing a per-list act, which means a CSV
 * re-import quietly resurrects somebody who opted out. See the block comment in
 * db/core.ts.
 *
 * ⚠ AND A BROADCAST'S NUMBERS ARE COMPUTED, NEVER STORED. They are aggregates
 * over the messages the fan-out produced, joined to their events, so a bounce
 * that arrives six hours later moves the number on its own. A counter column
 * would be wrong within a day and nothing would ever recompute it to disagree.
 */

export interface ContactRow {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  unsubscribed: boolean
  properties: Record<string, unknown> | null
  created_at: string
}

export interface SegmentRow {
  id: string
  name: string
  description: string | null
  contact_count: number
  created_at: string
}

export interface TopicRow {
  id: string
  name: string
  description: string | null
  default_subscription: string
  visibility: string
  subscriber_count: number
  created_at: string
}

export interface PropertyRow {
  id: string
  key: string
  type: string
  fallback_value: string | null
  created_at: string
}

export interface BroadcastRow {
  id: string
  segment_id: string | null
  segment_name: string | null
  topic_id: string | null
  name: string
  from: string
  reply_to: string[]
  subject: string
  preview_text: string | null
  html: string | null
  text: string | null
  status: string
  scheduled_at: string | null
  sent_at: string | null
  recipient_count: number | null
  created_at: string
}

/**
 * A broadcast as it appears in a LIST, which is the same row without its body.
 *
 * ⚠ THE BODY IS THE REASON THIS TYPE EXISTS. A broadcast's `html` is a whole
 * marketing email — tens to hundreds of kilobytes — and the list page renders
 * a name, a status and a date. Shipping the bodies made a hundred-broadcast
 * workspace a multi-megabyte JSON response to draw a table that displays none
 * of it, on a page somebody opens to find the one they want to edit.
 */
export type BroadcastSummary = Omit<BroadcastRow, "html" | "text">

/** A template in a list: the same row without its body, for the same reason. */
export type TemplateSummary = Omit<TemplateRow, "html" | "text">

/**
 * A write that named a segment or topic belonging to another workspace.
 *
 * ⚠ A DISTINCT SHAPE RATHER THAN `null`, BECAUSE THE ROUTE HAS TO SAY WHICH
 * FIELD. `null` already means "no such broadcast" on the update path, and
 * answering 404 for a bad `segment_id` would send somebody looking for the
 * broadcast they are currently editing.
 */
export interface UnknownTarget {
  unknown: "segment_id" | "topic_id"
}

export interface BroadcastStats {
  total: number
  delivered: number
  bounced: number
  complained: number
  failed: number
}

export interface TemplateRow {
  id: string
  name: string
  folder: string | null
  subject: string | null
  html: string | null
  text: string | null
  published_at: string | null
  version: number
  created_at: string
  updated_at: string
}

export interface ImportResult {
  parsed: number
  created: number
  updated: number
  invalid: number
}

export interface BroadcastInput {
  segmentId: string | null
  topicId: string | null
  name: string
  from: string
  replyTo: string[]
  subject: string
  previewText: string | null
  html: string | null
  text: string | null
  scheduledAt: Date | null
}

export interface MarketingStore {
  listContacts(
    tenantId: string,
    opts: { search?: string; segmentId?: string; cursor?: string; limit?: number },
  ): Promise<Page<ContactRow>>
  getContact(
    tenantId: string,
    id: string,
  ): Promise<
    | (ContactRow & {
        segments: { id: string; name: string }[]
        topics: { id: string; name: string; subscribed: boolean }[]
      })
    | null
  >
  /**
   * Add a contact, or fold the new fields into the one that is already there.
   *
   * ⚠ IT REPORTS WHICH OF THE TWO IT DID, BECAUSE THE ROUTE'S STATUS CODE
   * DEPENDS ON IT. 201 means "created"; answering it for a row that already
   * existed tells an SDK, a cache and anybody reading a request log that a
   * resource came into being when nothing did.
   */
  upsertContact(
    tenantId: string,
    input: {
      email: string
      firstName?: string | null
      lastName?: string | null
      unsubscribed?: boolean
      properties?: Record<string, unknown> | null
    },
  ): Promise<{ contact: ContactRow; created: boolean }>
  updateContact(
    tenantId: string,
    id: string,
    patch: {
      firstName?: string | null
      lastName?: string | null
      unsubscribed?: boolean
      properties?: Record<string, unknown> | null
    },
  ): Promise<ContactRow | null>
  deleteContacts(tenantId: string, ids: string[]): Promise<number>
  importContacts(tenantId: string, csv: string): Promise<ImportResult>

  listProperties(tenantId: string): Promise<PropertyRow[]>
  createProperty(
    tenantId: string,
    input: { key: string; type: string; fallbackValue?: string | null },
  ): Promise<PropertyRow | { conflict: true }>
  deleteProperty(tenantId: string, id: string): Promise<boolean>

  listSegments(tenantId: string): Promise<SegmentRow[]>
  createSegment(
    tenantId: string,
    input: { name: string; description?: string | null },
  ): Promise<SegmentRow>
  updateSegment(
    tenantId: string,
    id: string,
    patch: { name?: string; description?: string | null },
  ): Promise<boolean>
  deleteSegments(tenantId: string, ids: string[]): Promise<number>
  /**
   * Put contacts in a segment.
   *
   * ⚠ `null` MEANS "NO SUCH SEGMENT IN THIS WORKSPACE", which the route answers
   * as a 404. It is not the same as 0, which means the segment is real and
   * every contact was already in it.
   */
  addToSegment(
    tenantId: string,
    segmentId: string,
    contactIds: string[],
  ): Promise<number | null>
  removeFromSegment(
    tenantId: string,
    segmentId: string,
    contactIds: string[],
  ): Promise<number>

  listTopics(tenantId: string): Promise<TopicRow[]>
  createTopic(
    tenantId: string,
    input: {
      name: string
      description?: string | null
      defaultSubscription: "opt_in" | "opt_out"
      visibility: "private" | "public"
    },
  ): Promise<TopicRow>
  updateTopic(
    tenantId: string,
    id: string,
    patch: { name?: string; description?: string | null; visibility?: string },
  ): Promise<boolean>
  deleteTopic(tenantId: string, id: string): Promise<boolean>
  /**
   * Subscribe or unsubscribe one contact from one topic.
   *
   * ⚠ `false` MEANS THE CONTACT OR THE TOPIC IS NOT THIS WORKSPACE'S, and the
   * route answers 404. See the implementation for why an FK is not enough.
   */
  setTopicSubscription(
    tenantId: string,
    contactId: string,
    topicId: string,
    subscribed: boolean,
  ): Promise<boolean>

  /**
   * ⚠ BOUNDED AND BODY-FREE. See `BroadcastSummary`, and `LIST_CAP` for why the
   * count has a ceiling rather than a cursor.
   */
  listBroadcasts(tenantId: string): Promise<BroadcastSummary[]>
  getBroadcast(
    tenantId: string,
    id: string,
  ): Promise<(BroadcastRow & { stats: BroadcastStats }) | null>
  /**
   * ⚠ `{ unknown }` MEANS A TARGET THAT IS NOT THIS WORKSPACE'S, and the route
   * answers 422 naming the field. It is not the same as a failure: the request
   * was well formed, it just pointed at somebody else's segment or topic. See
   * `assertOwned` for why a foreign key does not catch this.
   */
  createBroadcast(
    tenantId: string,
    input: Partial<BroadcastInput> & { name: string },
  ): Promise<BroadcastRow | UnknownTarget>
  updateBroadcast(
    tenantId: string,
    id: string,
    patch: Partial<BroadcastInput>,
  ): Promise<BroadcastRow | UnknownTarget | null>
  deleteBroadcast(tenantId: string, id: string): Promise<boolean>

  listTemplates(tenantId: string): Promise<TemplateSummary[]>
  getTemplate(tenantId: string, id: string): Promise<TemplateRow | null>
  createTemplate(
    tenantId: string,
    input: { name: string; folder?: string | null },
  ): Promise<TemplateRow | { conflict: true }>
  updateTemplate(
    tenantId: string,
    id: string,
    patch: {
      name?: string
      folder?: string | null
      subject?: string | null
      html?: string | null
      text?: string | null
    },
  ): Promise<TemplateRow | null>
  publishTemplate(tenantId: string, id: string): Promise<TemplateRow | null>
  deleteTemplate(tenantId: string, id: string): Promise<boolean>
}
