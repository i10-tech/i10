import { defineView } from "./harness"
import {
  apiKey,
  broadcast,
  contact,
  domain,
  email,
  iso,
  request,
  rows,
  segment,
  suppression,
  topic,
  template,
  folder,
  installation,
  repository,
  trusted,
} from "./fixtures"

// ⚠ LOADED AFTER harness.tsx HAS MOCKED `server-only`; a static import would
// hoist above the mock and throw.
const { DomainsView } = await import("@/components/domains-view")
const { domainsShape } = await import("@/lib/shapes/domains")
const { ApiKeysView } = await import("@/components/api-keys-view")
const { apiKeysShape } = await import("@/lib/shapes/api-keys")
const { BroadcastsView } = await import("@/components/broadcasts-view")
const { broadcastsShape } = await import("@/lib/shapes/broadcasts")
const { ContactsView } = await import("@/components/contacts-view")
const { contactsShape } = await import("@/lib/shapes/contacts")
const { EmailsView } = await import("@/components/emails-view")
const { emailsShape } = await import("@/lib/shapes/emails")
const { LogsView } = await import("@/components/logs-view")
const { logsShape } = await import("@/lib/shapes/logs")
const { SegmentsView } = await import("@/components/segments-view")
const { segmentsShape } = await import("@/lib/shapes/segments")
const { SuppressionsView } = await import("@/components/suppressions-view")
const { suppressionsShape } = await import("@/lib/shapes/suppressions")
const { TopicsView } = await import("@/components/topics-view")
const { topicsShape } = await import("@/lib/shapes/topics")
const { TemplatesView } = await import("@/components/templates-view")
const { templatesShape } = await import("@/lib/shapes/templates")

function offer(tag: string, i: number) {
  return {
    id: `off_${tag}${i}`,
    domain_id: `dom_${tag}o${i}`,
    domain_name: `${tag}offer${i}.example.com`,
    recipient_email: `${tag}@example.com`,
    offered_by: `${tag} owner`,
    from_workspace: `${tag} workspace`,
    created_at: iso(1),
    expires_at: iso(-6),
  }
}

const domainsData =
  (over: Record<string, unknown>[], offers = 0) =>
  (tag: string) => ({
    domains: over.map((o, i) => domain(tag, i, o)),
    scopedKeys: {},
    offers: rows(offers, (i) => offer(tag, i)),
  })

export const LIST_VIEWS = [
  defineView({
    route: "/domains",
    pathname: "/domains",
    View: DomainsView,
    shape: domainsShape,
    cases: [
      { name: "empty", fixture: domainsData([]) },
      { name: "one", fixture: domainsData([{}]) },
      { name: "many", fixture: domainsData([{}, {}, {}, {}, {}]) },
      {
        name: "mixed statuses and regions (both filters)",
        fixture: domainsData([
          {},
          { status: "pending", region: "eu-west-1", delegated: true },
          { status: "failed" },
          { displaced_at: iso(30), status: "failed" },
        ]),
      },
      { name: "with transfer offers", fixture: domainsData([{}, {}], 2) },
      { name: "empty with an offer", fixture: domainsData([], 1) },
    ],
  }),

  defineView({
    route: "/api-keys",
    pathname: "/api-keys",
    View: ApiKeysView,
    shape: apiKeysShape,
    cases: [
      { name: "empty", fixture: () => ({ keys: [], domains: [] }) },
      {
        name: "one",
        fixture: (tag) => ({ keys: [apiKey(tag, 0)], domains: [domain(tag, 0)] }),
      },
      {
        name: "many, one revoked and one scoped",
        fixture: (tag) => ({
          keys: [
            ...rows(4, (i) => apiKey(tag, i)),
            apiKey(tag, 4, { revoked_at: iso(1) }),
            apiKey(tag, 5, { domains: [`${tag}0.example.com`] }),
          ],
          domains: [domain(tag, 0)],
        }),
      },
      {
        name: "a key without rights over it",
        fixture: (tag) => ({
          keys: [
            apiKey(tag, 0, { can_rotate: false, can_revoke: false, can_edit: false }),
          ],
          domains: [],
        }),
      },
    ],
  }),

  defineView({
    route: "/broadcasts",
    pathname: "/broadcasts",
    View: BroadcastsView,
    shape: broadcastsShape,
    cases: [
      { name: "empty", fixture: () => ({ broadcasts: [] }) },
      { name: "one", fixture: (tag) => ({ broadcasts: [broadcast(tag, 0)] }) },
      {
        name: "many (table)",
        fixture: (tag) => ({
          broadcasts: rows(5, (i) => broadcast(tag, i)),
          view: "table" as const,
        }),
      },
      {
        name: "many (grid)",
        fixture: (tag) => ({
          broadcasts: rows(5, (i) => broadcast(tag, i)),
          view: "grid" as const,
        }),
      },
      {
        name: "mixed statuses and segments (both filters), table",
        fixture: (tag) => ({
          broadcasts: [
            broadcast(tag, 0),
            broadcast(tag, 1, { status: "sent", sent_at: iso(1), recipient_count: 12 }),
            broadcast(tag, 2, {
              status: "scheduled",
              scheduled_at: iso(-2),
              segment_id: `seg_${tag}9`,
            }),
          ],
          view: "table" as const,
        }),
      },
      {
        name: "mixed statuses and segments (both filters), grid",
        fixture: (tag) => ({
          broadcasts: [
            broadcast(tag, 0),
            broadcast(tag, 1, { status: "sent", sent_at: iso(1), recipient_count: 12 }),
            broadcast(tag, 2, {
              status: "scheduled",
              scheduled_at: iso(-2),
              segment_id: `seg_${tag}9`,
            }),
          ],
          view: "grid" as const,
        }),
      },
    ],
  }),

  defineView({
    route: "/contacts",
    pathname: "/contacts",
    View: ContactsView,
    shape: contactsShape,
    cases: [
      {
        name: "empty",
        fixture: () => ({ contacts: [], nextCursor: null, segments: [] }),
      },
      {
        name: "one",
        fixture: (tag) => ({
          contacts: [contact(tag, 0)],
          nextCursor: null,
          segments: [],
        }),
      },
      {
        name: "many with segments (segment filter) and unsubscribed",
        fixture: (tag) => ({
          contacts: [
            ...rows(5, (i) => contact(tag, i)),
            contact(tag, 5, { unsubscribed: true, first_name: null, last_name: null }),
          ],
          nextCursor: null,
          segments: rows(2, (i) => segment(tag, i)),
        }),
      },
    ],
  }),

  defineView({
    route: "/emails",
    pathname: "/emails",
    View: EmailsView,
    shape: emailsShape,
    cases: [
      {
        name: "empty",
        fixture: () => ({ rows: [], nextCursor: null, domains: [], apiKeys: [] }),
      },
      {
        name: "one",
        fixture: (tag) => ({
          rows: [email(tag, 0)],
          nextCursor: null,
          domains: [domain(tag, 0)],
          apiKeys: [apiKey(tag, 0)],
        }),
      },
      {
        name: "many with another page behind them",
        fixture: (tag) => ({
          rows: [
            ...rows(5, (i) => email(tag, i)),
            email(tag, 5, {
              status: "bounced",
              last_event: "bounced",
              last_error: "550",
            }),
            email(tag, 6, {
              status: "scheduled",
              last_event: "scheduled",
              scheduled_at: iso(-1),
              sent_at: null,
            }),
          ],
          nextCursor: "next",
          domains: [domain(tag, 0)],
          apiKeys: [apiKey(tag, 0)],
        }),
      },
    ],
  }),

  defineView({
    route: "/logs",
    pathname: "/logs",
    View: LogsView,
    shape: logsShape,
    cases: [
      {
        name: "empty",
        fixture: () => ({ rows: [], nextCursor: null, apiKeys: [] }),
      },
      {
        name: "one",
        fixture: (tag) => ({ rows: [request(tag, 0)], nextCursor: null, apiKeys: [] }),
      },
      {
        name: "many with keys (key filter) and a failure",
        fixture: (tag) => ({
          rows: [
            ...rows(5, (i) => request(tag, i, { api_key_id: `key_${tag}0` })),
            request(tag, 5, { status: 500, error_name: "internal_error" }),
          ],
          nextCursor: "next",
          apiKeys: [{ id: `key_${tag}0`, name: `${tag} key` }],
        }),
      },
    ],
  }),

  defineView({
    route: "/segments",
    pathname: "/segments",
    View: SegmentsView,
    shape: segmentsShape,
    cases: [
      { name: "empty", fixture: () => ({ segments: [] }) },
      {
        name: "one (grid)",
        fixture: (tag) => ({ segments: [segment(tag, 0)], view: "grid" as const }),
      },
      {
        name: "many (grid)",
        fixture: (tag) => ({
          segments: rows(5, (i) => segment(tag, i)),
          view: "grid" as const,
        }),
      },
      {
        name: "many (table)",
        fixture: (tag) => ({
          segments: rows(5, (i) => segment(tag, i)),
          view: "table" as const,
        }),
      },
      {
        name: "no description",
        fixture: (tag) => ({
          segments: [segment(tag, 0, { description: null })],
          view: "table" as const,
        }),
      },
    ],
  }),

  defineView({
    route: "/suppressions",
    pathname: "/suppressions",
    View: SuppressionsView,
    shape: suppressionsShape,
    cases: [
      { name: "empty", fixture: () => ({ rows: [], nextCursor: null }) },
      {
        name: "one",
        fixture: (tag) => ({ rows: [suppression(tag, 0)], nextCursor: null }),
      },
      {
        name: "many with another page",
        fixture: (tag) => ({
          rows: rows(6, (i) => suppression(tag, i)),
          nextCursor: "next",
        }),
      },
    ],
  }),

  defineView({
    route: "/topics",
    pathname: "/topics",
    View: TopicsView,
    shape: topicsShape,
    cases: [
      { name: "empty", fixture: () => ({ topics: [] }) },
      {
        name: "one (table)",
        fixture: (tag) => ({ topics: [topic(tag, 0)], view: "table" as const }),
      },
      {
        name: "many (table)",
        fixture: (tag) => ({
          topics: rows(5, (i) => topic(tag, i)),
          view: "table" as const,
        }),
      },
      {
        name: "many (grid)",
        fixture: (tag) => ({
          topics: rows(5, (i) => topic(tag, i)),
          view: "grid" as const,
        }),
      },
      {
        name: "private opt-out topic",
        fixture: (tag) => ({
          topics: [
            topic(tag, 0, {
              visibility: "private",
              default_subscription: "opt_out",
              description: null,
            }),
          ],
          view: "table" as const,
        }),
      },
    ],
  }),

  defineView({
    route: "/templates",
    pathname: "/templates",
    View: TemplatesView,
    shape: templatesShape,
    cases: [
      { name: "empty", fixture: () => ({ templates: [], folders: [] }) },
      {
        name: "one (grid)",
        fixture: (tag) => ({
          templates: [template(tag, 0)],
          folders: [],
          view: "grid" as const,
        }),
      },
      {
        name: "many with folders (grid)",
        fixture: (tag) => ({
          templates: rows(5, (i) => template(tag, i)),
          folders: rows(2, (i) => folder(tag, i)),
          view: "grid" as const,
        }),
      },
      {
        name: "many with folders (table)",
        fixture: (tag) => ({
          templates: rows(5, (i) => template(tag, i)),
          folders: rows(2, (i) => folder(tag, i)),
          view: "table" as const,
        }),
      },
      {
        name: "github configured, not installed",
        fixture: (tag) => ({
          templates: [template(tag, 0)],
          folders: [],
          github: { configured: true, installations: [], repositories: [] },
          view: "grid" as const,
        }),
      },
      {
        name: "github installed, no repository yet",
        fixture: (tag) => ({
          templates: [template(tag, 0)],
          folders: [],
          github: {
            configured: true,
            installations: [installation(tag)],
            repositories: [],
          },
          view: "grid" as const,
        }),
      },
      {
        name: "github with repositories, one failing its sync",
        fixture: (tag) => ({
          templates: [template(tag, 0)],
          folders: [],
          github: {
            configured: true,
            installations: [installation(tag)],
            repositories: [repository(tag, 0), repository(tag, 1, true)],
          },
          view: "table" as const,
        }),
      },
      {
        name: "reviewed templates",
        fixture: (tag) => ({
          templates: [template(tag, 0)],
          folders: [],
          trusted: rows(2, (i) => trusted(tag, i)),
          view: "grid" as const,
        }),
      },
    ],
  }),
]
