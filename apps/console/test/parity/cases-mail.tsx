import { defineView } from "./harness"
import { iso, rows } from "./fixtures"

// ⚠ LOADED AFTER harness.tsx HAS MOCKED `server-only` (see cases-lists.tsx).
const { MailboxesView } = await import("@/components/mailboxes-view")
const { mailboxesShape } = await import("@/lib/shapes/mailboxes")
const { MailboxDetailView } = await import("@/components/mailbox-detail")
const { mailboxDetailShape } = await import("@/lib/shapes/mailbox-detail")
const { TeamInboxesView } = await import("@/components/team-inboxes-view")
const { teamInboxesShape } = await import("@/lib/shapes/team-inboxes")
const { TeamInboxDetailView } = await import("@/components/team-inbox-detail")
const { teamInboxDetailShape } = await import("@/lib/shapes/team-inbox-detail")

import type { MailboxAliasList } from "@/lib/mailbox-aliases"
import type { DevicesRead, MailDevice } from "@/lib/mail-devices"
import type { MailboxJob, TransferSnapshot } from "@/lib/mailbox-transfer"
import type { ConsoleMailbox, StoragePool } from "@/lib/mailbox-view"
import type { MailboxDetailData } from "@/lib/shapes/mailbox-detail"
import type { MailboxesData } from "@/lib/shapes/mailboxes"
import type { TeamInboxDetailData } from "@/lib/shapes/team-inbox-detail"
import type { TeamInboxesData } from "@/lib/shapes/team-inboxes"
import type { TeamInbox } from "@/lib/team-inbox"

const GB = 1024 ** 3

function mailbox(
  tag: string,
  i: number,
  over: Partial<ConsoleMailbox> = {},
): ConsoleMailbox {
  return {
    address: `${tag}${i}@acme.test`,
    displayName: `${tag} display ${i}`,
    owner: {
      userId: `usr_${tag}${i}`,
      name: `${tag} person ${i}`,
      email: `${tag}${i}@example.com`,
    },
    domain: "acme.test",
    status: "active",
    deletion: null,
    signIn: "password",
    storage: { allocatedBytes: 5 * GB, usedBytes: GB, usedAt: iso(1) },
    createdAt: iso(i + 3),
    ...over,
  }
}

const POOL: StoragePool = {
  kind: "pool",
  total: 50 * GB,
  allocated: 15 * GB,
  used: 3 * GB,
  remaining: 35 * GB,
  unallocated: 0,
}
const UNCAPPED: StoragePool = {
  kind: "uncapped",
  total: null,
  allocated: 0,
  used: 2 * GB,
  remaining: null,
  unallocated: 0,
}

const create = (hosted: boolean) => ({
  domains: hosted ? ["acme.test"] : [],
  held: {},
  clerkEnabled: false,
})

function mailboxesData(over: Partial<MailboxesData> & { n?: number } = {}) {
  const { n = 0, ...rest } = over
  return (tag: string): MailboxesData => ({
    mailboxes: rows(n, (i) => mailbox(tag, i)),
    pool: UNCAPPED,
    nextCursor: null,
    isAdmin: true,
    selfServe: false,
    create: create(true),
    ...rest,
  })
}

function inbox(tag: string, i: number, named = true): TeamInbox {
  return {
    object: "team_inbox",
    address: `${tag}team${i}@acme.test`,
    display_name: named ? `${tag} team ${i}` : null,
    members: rows(2 + i, (m) => ({ address: `${tag}m${m}@acme.test` })),
    created_at: iso(i + 2),
  }
}

const inboxesData =
  (n: number, over: Partial<TeamInboxesData> = {}) =>
  (tag: string): TeamInboxesData => ({
    inboxes: rows(n, (i) => inbox(tag, i, i % 2 === 0)),
    isAdmin: true,
    create: { domains: ["acme.test"], candidates: [] },
    ...over,
  })

const aliasList = (tag: string, n: number): MailboxAliasList => ({
  limit: 30,
  data: rows(n, (i) => ({
    address: `${tag}alias${i}@acme.test`,
    source: i % 2 === 0 ? ("console" as const) : ("clerk" as const),
  })),
})

const device = (tag: string, i: number): MailDevice => ({
  object: "mail_device",
  id: `${tag}dev${i}`,
  email: "a@acme.test",
  platform: i % 3 === 0 ? "ios" : i % 3 === 1 ? "macos" : "ipados",
  device_name: i % 2 === 0 ? `${tag}Phone ${i}` : null,
  model: i % 2 === 0 ? null : "MacBook Air",
  serial: i % 2 === 0 ? null : `${tag}C02X${i}`,
  created_at: iso(3 + i),
  first_used_at: i === 0 ? null : iso(2),
  last_used_at: i === 0 ? null : iso(1),
  created_by: "user_a",
  has_certificate_key: i % 3 === 1,
})

const devices = (tag: string, n: number): DevicesRead => ({
  state: "ok",
  list: { data: rows(n, (i) => device(tag, i)), next_cursor: null },
})

const job = (
  type: "export" | "import",
  status: MailboxJob["status"],
  over = {},
): MailboxJob => ({
  object: "mailbox_job",
  id: `job_${type}`,
  mailbox_address: "a@acme.test",
  type,
  status,
  progress: {
    total_messages: 200,
    processed_messages: 80,
    total_folders: 4,
    processed_folders: 2,
  },
  created_at: iso(1),
  ...over,
})

const ok = (
  exported: MailboxJob | null = null,
  imported: MailboxJob | null = null,
): TransferSnapshot => ({ state: "ok", export: exported, import: imported })

function detail(over: (tag: string) => Partial<MailboxDetailData> = () => ({})) {
  return (tag: string): MailboxDetailData => ({
    mailbox: mailbox(tag, 0),
    others: [mailbox(tag, 1)],
    pool: POOL,
    aliases: aliasList(tag, 2),
    domains: ["acme.test"],
    transfer: ok(),
    devices: devices(tag, 2),
    isAdmin: true,
    renderedAt: iso(0),
    ...over(tag),
  })
}

const deleting = (
  tag: string,
  outcome: "delete" | "export_then_delete" | "forward",
  wait: ConsoleMailbox["deletion"] = null,
) =>
  mailbox(tag, 0, {
    status: "deleting",
    deletion: {
      outcome,
      deletedAt: iso(1),
      purgeAt: iso(-29),
      forwardTo: outcome === "forward" ? `${tag}fwd@acme.test` : null,
      exportWait: wait?.exportWait ?? null,
    },
  })

export const MAIL_VIEWS = [
  defineView({
    route: "/mailboxes",
    pathname: "/mailboxes",
    View: MailboxesView,
    shape: mailboxesShape,
    cases: [
      { name: "admin, empty, a domain hosts mailboxes", fixture: mailboxesData() },
      {
        name: "admin, empty, no domain hosts mailboxes",
        fixture: mailboxesData({ create: create(false) }),
      },
      { name: "admin, one mailbox", fixture: mailboxesData({ n: 1 }) },
      {
        name: "admin, many, capped pool, unallocated, next page",
        fixture: mailboxesData({
          n: 5,
          pool: { ...POOL, unallocated: 2 },
          nextCursor: "next",
        }),
      },
      {
        name: "admin, single unallocated mailbox",
        fixture: mailboxesData({ n: 2, pool: { ...UNCAPPED, unallocated: 1 } }),
      },
      {
        name: "member with a mailbox",
        fixture: mailboxesData({ n: 1, isAdmin: false }),
      },
      {
        name: "member with a single sign-on mailbox",
        fixture: (tag) => ({
          ...mailboxesData({ isAdmin: false })(tag),
          mailboxes: [mailbox(tag, 0, { signIn: "oidc" })],
        }),
      },
      {
        name: "member, none, may create their own",
        fixture: mailboxesData({ isAdmin: false, selfServe: true }),
      },
      {
        name: "member, none, an admin creates them",
        fixture: mailboxesData({ isAdmin: false }),
      },
    ],
  }),

  defineView({
    route: "/mailboxes/[address]",
    pathname: "/mailboxes/a@acme.test",
    params: { address: "a@acme.test" },
    View: MailboxDetailView,
    shape: mailboxDetailShape,
    cases: [
      { name: "admin, active", fixture: detail() },
      {
        name: "member, own mailbox, three devices",
        fixture: detail((tag) => ({ isAdmin: false, devices: devices(tag, 3) })),
      },
      {
        name: "no devices yet",
        fixture: detail((tag) => ({ devices: devices(tag, 0) })),
      },
      {
        name: "devices could not be read",
        fixture: detail(() => ({ devices: { state: "error" } })),
      },
      {
        name: "devices not this viewer's (hidden)",
        fixture: detail(() => ({ devices: { state: "hidden" } })),
      },
      {
        name: "admin, suspended (resume and a note)",
        fixture: detail((tag) => ({
          mailbox: mailbox(tag, 0, { status: "suspended" }),
        })),
      },
      {
        name: "admin, sign-in blocked (danger note), storage not measured",
        fixture: detail((tag) => ({
          mailbox: mailbox(tag, 0, {
            status: "banned",
            storage: { allocatedBytes: null, usedBytes: null, usedAt: null },
          }),
        })),
      },
      {
        name: "admin, storage measured against the default quota",
        fixture: detail((tag) => ({
          mailbox: mailbox(tag, 0, {
            storage: { allocatedBytes: null, usedBytes: GB, usedAt: iso(1) },
          }),
        })),
      },
      {
        name: "admin, deleting with an export first",
        fixture: detail((tag) => ({
          mailbox: deleting(tag, "export_then_delete", {
            outcome: "export_then_delete",
            deletedAt: iso(1),
            purgeAt: iso(-29),
            forwardTo: null,
            exportWait: { reason: "export_failed", readyAfter: null },
          }),
        })),
      },
      {
        name: "admin, deleting with forwarding",
        fixture: detail((tag) => ({ mailbox: deleting(tag, "forward") })),
      },
      {
        name: "admin, no aliases",
        fixture: detail((tag) => ({ aliases: aliasList(tag, 0) })),
      },
      {
        name: "admin, every alias the limit allows (add alias blocked)",
        fixture: detail((tag) => ({
          aliases: {
            limit: 8,
            data: rows(8, (i) => ({
              address: `${tag}a${i}@acme.test`,
              source: "console" as const,
            })),
          },
        })),
      },
      {
        name: "admin, no domain hosts mailboxes (add alias blocked)",
        fixture: detail(() => ({ domains: [] })),
      },
      { name: "admin, aliases unreadable", fixture: detail(() => ({ aliases: null })) },
      {
        name: "member, their own mailbox",
        fixture: detail(() => ({
          isAdmin: false,
          others: [],
          pool: null,
          domains: [],
        })),
      },
      {
        name: "export ready, import finished",
        fixture: detail(() => ({
          transfer: ok(
            job("export", "completed", {
              download_url: "https://example.test/x",
              completed_at: iso(1),
            }),
            job("import", "completed", { completed_at: iso(1) }),
          ),
        })),
      },
      {
        name: "export and import running",
        fixture: detail(() => ({
          transfer: ok(job("export", "running"), job("import", "running")),
        })),
      },
      {
        name: "export failed, import failed",
        fixture: detail(() => ({
          transfer: ok(
            job("export", "failed", { error_code: "internal" }),
            job("import", "failed", { error_code: "archive_invalid" }),
          ),
        })),
      },
      {
        name: "export expired, import never finished uploading",
        fixture: detail(() => ({
          transfer: ok(
            job("export", "completed", { completed_at: iso(10) }),
            job("import", "awaiting_upload"),
          ),
        })),
      },
      {
        name: "transfer hidden from this person",
        fixture: detail(() => ({ transfer: { state: "forbidden" } })),
      },
      {
        name: "transfer not available on this deployment",
        fixture: detail(() => ({ transfer: { state: "unavailable" } })),
      },
      {
        name: "transfer status could not be read",
        fixture: detail(() => ({ transfer: { state: "unreadable" } })),
      },
    ],
  }),

  defineView({
    route: "/team-inboxes",
    pathname: "/team-inboxes",
    View: TeamInboxesView,
    shape: teamInboxesShape,
    cases: [
      { name: "admin, empty, a domain hosts mailboxes", fixture: inboxesData(0) },
      {
        name: "admin, empty, no domain hosts mailboxes",
        fixture: inboxesData(0, { create: { domains: [], candidates: [] } }),
      },
      { name: "admin, one", fixture: inboxesData(1) },
      { name: "admin, many (named and not)", fixture: inboxesData(4) },
      { name: "member, none", fixture: inboxesData(0, { isAdmin: false }) },
      { name: "member, some", fixture: inboxesData(2, { isAdmin: false }) },
    ],
  }),

  defineView({
    route: "/team-inboxes/[address]",
    pathname: "/team-inboxes/a@acme.test",
    params: { address: "a@acme.test" },
    View: TeamInboxDetailView,
    shape: teamInboxDetailShape,
    cases: [
      {
        name: "admin, named inbox",
        fixture: (tag): TeamInboxDetailData => ({
          inbox: inbox(tag, 1),
          candidates: [{ address: `${tag}c@acme.test`, name: `${tag} candidate` }],
          isAdmin: true,
        }),
      },
      {
        name: "admin, unnamed inbox",
        fixture: (tag): TeamInboxDetailData => ({
          inbox: inbox(tag, 0, false),
          candidates: [],
          isAdmin: true,
        }),
      },
      {
        name: "member, read-only list",
        fixture: (tag): TeamInboxDetailData => ({
          inbox: inbox(tag, 2),
          candidates: [],
          isAdmin: false,
        }),
      },
    ],
  }),
]
