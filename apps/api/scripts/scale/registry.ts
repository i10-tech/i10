/**
 * The hot-query registry: every query that runs often or on a hot path, found
 * from the code (production has no traffic yet to rank them by).
 *
 * Each entry runs the REAL code path (a store method, a statement builder, or
 * authd's SQL read from its Go source) inside `capture`, so what is measured is
 * what production sends. `source` says which:
 *   - `code`: the application function itself was called;
 *   - `go-source`: the SQL text was read out of authd's Go file by go-sql.ts;
 *   - `call-text`: the statement is a one-line call of a SQL function inside an
 *     entry point that exports nothing callable (a CronJob's main), copied with
 *     its call site; the function's body is what gets measured, via auto_explain.
 *
 * Cases are the parameter pickers. Every entry has its worst case (the huge
 * tenant) and a low-volume one (empty tenant, missing row). A case may also
 * `expect` something of the result: that is how a fixture turns into a bug
 * report instead of just a timing.
 */
import { claimStatement, markSentStatement } from "../../src/db/claim.js"
import { tenantResolver } from "../../src/middleware/tenant.js"
import { keyLookup } from "../../src/auth/store.js"
import { workspacePolicyStore } from "../../src/identity/workspace-policy-store.js"
import { identityStore } from "../../src/identity/store.js"
import { consoleQueries } from "../../src/console/queries.js"
import { acceptDatabaseOps } from "../../src/send/accept-db.js"
import { emailLookup } from "../../src/send/lookup.js"
import { sweepStatement } from "../../src/send/sweep.js"
import { meterEventStore, planAssignmentStore } from "../../src/metering/postgres.js"
import { unshippedStatement } from "../../src/metering/ingest.js"
import {
  dueDeliveries,
  webhookDeliveryOps,
  webhookEventOps,
} from "../../src/webhooks/db.js"
import { unfannedHealthEvents } from "../../src/webhooks/health.js"
import { consoleMailboxStore } from "../../src/mailboxes/console.js"
import { mailboxSweepStore } from "../../src/mailboxes/sweep.js"
import { sql } from "drizzle-orm"
import { withTenant } from "../../src/db/client.js"
import type { CaptureContext } from "./capture.js"
import { FIXTURE_TENANTS } from "./fixtures.js"
import { goConst, goQueries } from "./go-sql.js"
import { MISSING_UUID, type Pickers } from "./pickers.js"

export type Area =
  "authd" | "api" | "send" | "worker" | "webhooks" | "console" | "scheduled"

export interface Case<A> {
  name: string
  arg: (p: Pickers) => Promise<A>
  /** Returns a description of what is wrong with the result, or null. */
  expect?: (result: unknown) => string | null
}

export interface Entry<A = unknown> {
  name: string
  area: Area
  site: { file: string; anchor: string }
  source: "code" | "go-source" | "call-text"
  frequency: string
  role: "i10_api" | "authd"
  cases: Case<A>[]
  run: (ctx: CaptureContext, arg: A) => Promise<unknown>
}

const entry = <A>(e: Entry<A>): Entry => e as unknown as Entry

const PROJECTION = "services/authd/internal/projection/postgres.go"
const BUDGET = "services/authd/internal/budgetstore/postgres.go"

/** Runs authd's queries for one method, in order, with the given parameter per query. */
const goRun =
  (method: string, params: (i: number) => unknown[]) => async (ctx: CaptureContext) => {
    const out: unknown[] = []
    for (const [i, text] of goQueries(PROJECTION, method).entries())
      out.push(await ctx.query(text, params(i)))
    return out
  }

const stubQueue = { add: async () => ({ id: "stub" }) }
const sendOps = (ctx: CaptureContext) =>
  acceptDatabaseOps({
    db: ctx.db,
    queues: { transactional: stubQueue, bulk: stubQueue } as never,
  })

const rowsOf = (r: unknown) => (Array.isArray(r) ? (r[0] as unknown[]) : [])
const hasRows = (want: boolean) => (r: unknown) =>
  rowsOf(r).length > 0 === want
    ? null
    : want
      ? "expected a row, got none"
      : "expected no row, got one"

const days = (n: number) => new Date(Date.now() - n * 86_400_000)

export const REGISTRY: Entry[] = [
  // --- authd (Go, as the `authd` role) --------------------------------------
  entry<string[]>({
    name: "authd.accounts_by_address",
    area: "authd",
    site: { file: PROJECTION, anchor: "func (p *Postgres) AccountsByAddress(" },
    source: "go-source",
    frequency:
      "every IMAP/SMTP bind and every LDAP search Stalwart makes for a login or a recipient",
    role: "authd",
    cases: [
      {
        name: "huge tenant login",
        arg: async (p) => [await p.hugeAccount()],
        expect: hasRows(true),
      },
      {
        name: "alias",
        arg: async (p) => [await p.aliasAddress()],
        expect: hasRows(true),
      },
      {
        // What authd sends after normalise() lowercases it; the row says `Sales@...`.
        name: "alias stored with capitals",
        arg: async () => ["sales@mixedcase.example"],
        expect: (r) =>
          hasRows(true)(r)
            ? "an alias stored as Sales@mixedcase.example receives nothing: authd compares the raw column to the lowercased address"
            : null,
      },
      {
        name: "sso required domain",
        arg: async (p) => [await p.ssoAccount()],
        expect: hasRows(true),
      },
      // The domain row says `MixedCase.Example`; the mailbox must still be found and hosted.
      {
        name: "mixed-case domain row",
        arg: async () => ["ceo@mixedcase.example"],
        expect: hasRows(true),
      },
      {
        name: "missing address",
        arg: async () => ["nobody@nowhere.example"],
        expect: hasRows(false),
      },
      { name: "50 recipients at once", arg: async (p) => p.manyAddresses() },
    ],
    run: (ctx, addresses) => goRun("AccountsByAddress", () => [addresses])(ctx),
  }),
  entry<string>({
    name: "authd.account_by_uid",
    area: "authd",
    site: { file: PROJECTION, anchor: "func (p *Postgres) AccountByUID(" },
    source: "go-source",
    frequency:
      "every bind once the login is resolved (authd re-reads the row it binds)",
    role: "authd",
    cases: [
      { name: "huge tenant", arg: async (p) => p.accountId(await p.hugeAccount()) },
      { name: "every gate set", arg: async () => "user_fixture_every-gate" },
      { name: "missing", arg: async () => "user_missing" },
    ],
    run: (ctx, uid) => goRun("AccountByUID", () => [uid])(ctx),
  }),
  entry<string[]>({
    name: "authd.groups_by_address",
    area: "authd",
    site: { file: PROJECTION, anchor: "func (p *Postgres) GroupsByAddress(" },
    source: "go-source",
    frequency: "every recipient lookup that is not a mailbox (team inboxes, lists)",
    role: "authd",
    cases: [
      { name: "huge tenant group", arg: async (p) => [await p.hugeGroupEmail()] },
      {
        name: "address stored with capitals",
        arg: async () => ["support@mixedcase.example"],
        expect: hasRows(true),
      },
      { name: "missing", arg: async () => ["nobody@nowhere.example"] },
    ],
    run: (ctx, addresses) =>
      goRun("GroupsByAddress", (i) => (i === 0 ? [addresses] : [[]]))(ctx),
  }),
  entry<string>({
    name: "authd.groups_for_member",
    area: "authd",
    site: { file: PROJECTION, anchor: "func (p *Postgres) GroupsForMember(" },
    source: "go-source",
    frequency: "every memberOf search (Stalwart asks per session for shared folders)",
    role: "authd",
    cases: [
      { name: "member of the most groups", arg: (p) => p.busyMember() },
      { name: "no groups", arg: async () => "user_missing" },
    ],
    run: (ctx, uid) => goRun("GroupsForMember", () => [uid])(ctx),
  }),
  entry<string[]>({
    name: "authd.groups_by_name",
    area: "authd",
    site: { file: PROJECTION, anchor: "func (p *Postgres) GroupsByName(" },
    source: "go-source",
    frequency: "every group expansion by name",
    role: "authd",
    cases: [{ name: "20 groups", arg: (p) => p.groupNames() }],
    run: (ctx, names) => goRun("GroupsByName", () => [names])(ctx),
  }),
  entry<string[]>({
    name: "authd.hydrate",
    area: "authd",
    site: { file: PROJECTION, anchor: "func (p *Postgres) hydrate(" },
    source: "go-source",
    frequency:
      "after every account query: aliases and memberships of the accounts found",
    role: "authd",
    cases: [
      {
        name: "one huge tenant account",
        arg: async (p) => [await p.accountId(await p.hugeAccount())],
      },
      {
        name: "50 accounts",
        arg: async (p) =>
          Promise.all((await p.manyAddresses()).map((e) => p.accountId(e))),
      },
    ],
    run: (ctx, ids) => goRun("hydrate", () => [ids])(ctx),
  }),
  entry<string[]>({
    name: "authd.group_members",
    area: "authd",
    site: { file: PROJECTION, anchor: "func (p *Postgres) scanAndFillGroups(" },
    source: "go-source",
    frequency: "after every group query: the active members of the groups found",
    role: "authd",
    cases: [{ name: "20 groups", arg: (p) => p.groupNames() }],
    run: (ctx, names) => goRun("scanAndFillGroups", () => [names])(ctx),
  }),
  entry<string>({
    name: "authd.budget_reserve",
    area: "authd",
    site: { file: BUDGET, anchor: "const reserveSQL" },
    source: "go-source",
    frequency: "each failed password forwarded to a company IdP (inert for Clerk)",
    role: "authd",
    cases: [{ name: "a person", arg: async (p) => p.accountId(await p.hugeAccount()) }],
    run: (ctx, uid) => ctx.query(goConst(BUDGET, "reserveSQL"), [uid, 600, 10]),
  }),

  // --- API per request ------------------------------------------------------
  entry<string>({
    name: "api.resolve_api_key",
    area: "api",
    site: { file: "apps/api/src/auth/store.ts", anchor: "async byHash(hash)" },
    source: "code",
    frequency: "every API request whose key is not in the 1 hour Redis cache",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant key",
        arg: async (p) => p.liveKeyHash(await p.hugeTenant()),
      },
      { name: "revoked", arg: (p) => p.revokedKeyHash() },
      { name: "missing", arg: async () => "0".repeat(64) },
    ],
    run: (ctx, hash) => keyLookup(ctx.db).byHash(hash),
  }),
  entry<string>({
    name: "api.workspace_policy",
    area: "api",
    site: {
      file: "apps/api/src/identity/workspace-policy-store.ts",
      anchor: "async policy(tenantId)",
    },
    source: "code",
    frequency: "every API-key request (admitApiKey) and every console request (admit)",
    role: "i10_api",
    cases: [
      { name: "sso tenant", arg: (p) => p.ssoTenant() },
      { name: "huge tenant", arg: (p) => p.hugeTenant() },
      { name: "empty tenant", arg: (p) => p.emptyTenant() },
    ],
    run: (ctx, tenant) => workspacePolicyStore(ctx.db).policy(tenant),
  }),
  entry<string>({
    name: "api.record_request",
    area: "api",
    site: {
      file: "apps/api/src/console/queries.ts",
      anchor: "async recordRequest(input)",
    },
    source: "code",
    frequency: "every API request (the request log)",
    role: "i10_api",
    cases: [{ name: "huge tenant", arg: (p) => p.hugeTenant() }],
    run: async (ctx, tenant) =>
      consoleQueries(ctx.db).recordRequest({
        tenantId: tenant,
        apiKeyId: null,
        method: "POST",
        path: "/emails",
        status: 200,
        durationMs: 12,
        userAgent: "curl/8",
        clientIp: "203.0.113.7",
        country: "DE",
      }),
  }),
  entry<{ userId: string; orgId: string | null }>({
    name: "console.tenant_for_principal",
    area: "console",
    site: {
      file: "apps/api/src/middleware/tenant.ts",
      anchor: "async resolve({ userId, orgId })",
    },
    source: "code",
    frequency: "every console request",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant owner",
        arg: async (p) => p.principal(await p.hugeTenant()),
      },
      { name: "personal workspace", arg: (p) => p.principal(FIXTURE_TENANTS.empty) },
      {
        name: "unknown person",
        arg: async () => ({ userId: "user_missing", orgId: null }),
      },
    ],
    run: (ctx, who) => tenantResolver(ctx.db).resolve(who),
  }),
  entry<{ sessionId: string; userId: string }>({
    name: "console.sso_gate_read",
    area: "console",
    site: {
      file: "apps/api/src/identity/store.ts",
      anchor: "async gateRead(clerkUserId, sessionId)",
    },
    source: "code",
    frequency: "every console request (the SSO session gate)",
    role: "i10_api",
    cases: [
      {
        name: "sso tenant session",
        arg: async (p) => p.sessionOf(await p.ssoTenant()),
      },
      { name: "no sso", arg: async (p) => p.sessionOf(await p.medianTenant()) },
    ],
    run: (ctx, s) => identityStore(ctx.db, null).gateRead(s.userId, s.sessionId),
  }),
  entry<string>({
    name: "console.session_facts",
    area: "console",
    site: {
      file: "apps/api/src/identity/workspace-policy-store.ts",
      anchor: "async sessionFacts(tenantId, sessionId)",
    },
    source: "code",
    frequency: "every console request in a workspace with a session policy",
    role: "i10_api",
    cases: [{ name: "sso tenant", arg: (p) => p.ssoTenant() }],
    run: (ctx, tenant) =>
      workspacePolicyStore(ctx.db).sessionFacts(tenant, "sess_missing"),
  }),

  // --- the send path --------------------------------------------------------
  entry<{ tenant: string; domains: string[] }>({
    name: "send.sendable_from",
    area: "send",
    site: {
      file: "apps/api/src/send/accept-db.ts",
      anchor: "async sendableFrom(tenantId, domains)",
    },
    source: "code",
    frequency: "every send (POST /emails, batch, broadcast)",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return { tenant: t, domains: await p.sendingDomains(t) }
        },
      },
      {
        name: "domain stored with capitals",
        arg: async () => ({
          tenant: FIXTURE_TENANTS.mixedCase,
          domains: ["mixedcase.example"],
        }),
        expect: (r) =>
          (r as Set<string>).has("mixedcase.example")
            ? null
            : "a verified domain stored as MixedCase.Example is not sendable: the gate compares the raw column to a lowercased name",
      },
      {
        name: "empty tenant",
        arg: async () => ({
          tenant: FIXTURE_TENANTS.empty,
          domains: ["nothing.example"],
        }),
      },
    ],
    run: (ctx, a) => sendOps(ctx).sendableFrom(a.tenant, a.domains),
  }),
  entry<{ tenant: string; to: string[] }>({
    name: "send.suppressed_for",
    area: "send",
    site: {
      file: "apps/api/src/send/accept-db.ts",
      anchor: "async suppressedFor(tenantId, addresses)",
    },
    source: "code",
    frequency: "every send",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant, 1 recipient",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return { tenant: t, to: await p.recipients(t, 1) }
        },
      },
      {
        name: "huge tenant, 50 recipients",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return { tenant: t, to: await p.recipients(t, 50) }
        },
      },
      {
        name: "suppression stored with capitals",
        arg: async () => ({
          tenant: FIXTURE_TENANTS.mixedCase,
          to: ["bob@example.test"],
        }),
        expect: (r) =>
          (r as Set<string>).size > 0
            ? null
            : "a suppression stored as Bob@Example.test does not stop mail to bob@example.test",
      },
    ],
    run: (ctx, a) => sendOps(ctx).suppressedFor(a.tenant, a.to),
  }),
  entry<string>({
    name: "send.paused_and_held",
    area: "send",
    site: {
      file: "apps/api/src/send/accept-db.ts",
      anchor: "async sendingPaused(tenantId: string)",
    },
    source: "code",
    frequency: "every send (SES pause and risk hold gates)",
    role: "i10_api",
    cases: [{ name: "huge tenant", arg: (p) => p.hugeTenant() }],
    run: async (ctx, tenant) => {
      const ops = sendOps(ctx)
      return [await ops.sendingPaused?.(tenant), await ops.sendingHeld?.(tenant)]
    },
  }),
  entry<{ tenant: string; n: number; idem: boolean; from: string }>({
    name: "send.persist",
    area: "send",
    site: { file: "apps/api/src/send/accept-db.ts", anchor: "async persist(input)" },
    source: "code",
    frequency: "every accepted send (one transaction per request, a batch is one call)",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant, 1 message, idempotency key",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return {
            tenant: t,
            n: 1,
            idem: true,
            from: `noreply@${(await p.sendingDomains(t))[0]}`,
          }
        },
      },
      {
        name: "huge tenant, batch of 100",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return {
            tenant: t,
            n: 100,
            idem: false,
            from: `noreply@${(await p.sendingDomains(t))[0]}`,
          }
        },
      },
    ],
    run: (ctx, a) => {
      const from = a.from
      return sendOps(ctx).persist({
        tenantId: a.tenant,
        apiKeyId: null,
        queue: "transactional",
        idempotencyKey: a.idem ? `scale-${a.tenant}` : undefined,
        requestHash: "h",
        messages: Array.from({ length: a.n }, (_, i) => ({
          payload: {
            from,
            to: [`r${i}@example.test`],
            subject: "Scale",
            text: "hello",
          },
          to: [`r${i}@example.test`],
          cc: [],
          bcc: [],
          scheduledAt: null,
          templateVersionId: null,
        })),
      } as never)
    },
  }),
  entry<{ tenant: string; day: boolean }>({
    name: "send.metering_used_in",
    area: "send",
    site: {
      file: "apps/api/src/metering/postgres.ts",
      anchor: "export const usedInStatement",
    },
    source: "code",
    frequency: "every send (allowance check)",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant, month window",
        arg: async (p) => ({ tenant: await p.hugeTenant(), day: false }),
      },
      {
        name: "median tenant, day window",
        arg: async (p) => ({ tenant: await p.medianTenant(), day: true }),
      },
    ],
    run: (ctx, a) =>
      meterEventStore(ctx.db).usedIn(
        { tenantId: a.tenant, featureId: "emails", shard: 0 },
        { start: days(a.day ? 1 : 30), end: null },
      ),
  }),
  entry<string>({
    name: "send.metering_record",
    area: "send",
    site: {
      file: "apps/api/src/metering/postgres.ts",
      anchor: "async record(key, events)",
    },
    source: "code",
    frequency: "every accepted send",
    role: "i10_api",
    cases: [{ name: "huge tenant", arg: (p) => p.hugeTenant() }],
    run: (ctx, tenant) =>
      meterEventStore(ctx.db).record(
        { tenantId: tenant, featureId: "emails", shard: 0 },
        [{ id: "scale-event", value: 1, at: new Date() }],
      ),
  }),
  entry<string>({
    name: "send.plan_assignment",
    area: "send",
    site: { file: "apps/api/src/metering/postgres.ts", anchor: "async find(tenantId)" },
    source: "code",
    frequency: "every send (which allowances apply)",
    role: "i10_api",
    cases: [
      { name: "huge tenant (custom plan)", arg: (p) => p.hugeTenant() },
      { name: "empty tenant (no row)", arg: (p) => p.emptyTenant() },
    ],
    run: (ctx, tenant) => planAssignmentStore(ctx.db).find(tenant),
  }),

  // --- the send worker ------------------------------------------------------
  entry<{ tenant: string; refs: { id: string; createdAt: Date }[] }>({
    name: "worker.claim",
    area: "worker",
    site: {
      file: "apps/api/src/db/claim.ts",
      anchor: "export function claimStatement(",
    },
    source: "code",
    frequency: "every send job (one claim per batch)",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant, 1 message",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return { tenant: t, refs: await p.queuedRefs(t, 1) }
        },
      },
      {
        name: "huge tenant, 100 messages",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return { tenant: t, refs: await p.queuedRefs(t, 100) }
        },
      },
    ],
    // As worker/db-adapter.ts runs it: the claim inside the tenant's transaction.
    run: (ctx, a) =>
      withTenant(ctx.db, a.tenant, (tx) =>
        tx.execute(
          claimStatement(a.refs, { workerId: "scale", staleAfter: "5 minutes" }),
        ),
      ),
  }),
  entry<{ tenant: string; ref: { id: string; createdAt: Date } }>({
    name: "worker.mark_sent",
    area: "worker",
    site: {
      file: "apps/api/src/db/claim.ts",
      anchor: "export function markSentStatement(",
    },
    source: "code",
    frequency: "every message sent",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return {
            tenant: t,
            ref: (await p.queuedRefs(t, 1))[0] ?? (await p.recentMessage(t)),
          }
        },
      },
    ],
    run: (ctx, a) =>
      withTenant(ctx.db, a.tenant, (tx) =>
        tx.execute(markSentStatement(a.ref, "scale", "ses-id", "ses")),
      ),
  }),
  entry<number>({
    name: "scheduled.stuck_messages",
    area: "scheduled",
    site: {
      file: "apps/api/src/send/sweep.ts",
      anchor: "export function sweepStatement(",
    },
    source: "code",
    frequency: "every minute (CronJob)",
    role: "i10_api",
    cases: [{ name: "500 rows", arg: async () => 500 }],
    run: (ctx, max) => ctx.db.execute(sweepStatement("2 minutes", "5 minutes", max)),
  }),

  // --- webhooks ------------------------------------------------------------
  entry<string>({
    name: "webhooks.message_owner",
    area: "webhooks",
    site: { file: "apps/api/src/webhooks/db.ts", anchor: "async ownerOf(messageId)" },
    source: "code",
    frequency:
      "every SES/SNS event (delivery, bounce, open, click): several per message",
    role: "i10_api",
    cases: [
      {
        name: "recent message",
        arg: async (p) => (await p.recentMessage(await p.hugeTenant())).id,
        expect: (r) => (r ? null : "owner not found"),
      },
      {
        name: "oldest message",
        arg: async (p) => (await p.oldMessage(await p.hugeTenant())).id,
        expect: (r) => (r ? null : "owner not found"),
      },
      { name: "missing", arg: async () => MISSING_UUID },
    ],
    run: (ctx, id) =>
      webhookEventOps({ db: ctx.db, queue: stubQueue as never }).ownerOf(id),
  }),
  entry<{ tenant: string; id: string; from: string }>({
    name: "webhooks.record_event",
    area: "webhooks",
    site: {
      file: "apps/api/src/webhooks/db.ts",
      anchor: "async record({ tenantId, event })",
    },
    source: "code",
    frequency: "every SES/SNS event, after its owner is found",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant, delivered",
        arg: async (p) => {
          const t = await p.hugeTenant()
          const d = await p.sendingDomains(t)
          return {
            tenant: t,
            id: (await p.recentMessage(t)).id,
            from: `noreply@${d[0]}`,
          }
        },
      },
    ],
    run: (ctx, a) =>
      webhookEventOps({ db: ctx.db, queue: stubQueue as never }).record({
        tenantId: a.tenant,
        event: {
          type: "email.delivered",
          messageId: a.id,
          occurredAt: new Date(),
          sourceEventId: "scale-event",
          raw: {},
          suppress: [],
          data: { from: a.from },
        },
      } as never),
  }),
  entry<{ deliveryId: string; endpointId: string; tenantId: string; attempt?: number }>(
    {
      name: "webhooks.load_delivery",
      area: "webhooks",
      site: {
        file: "apps/api/src/webhooks/db.ts",
        anchor: "async load(job: WebhookJob)",
      },
      source: "code",
      frequency: "every webhook delivery attempt",
      role: "i10_api",
      cases: [
        { name: "huge tenant", arg: async (p) => p.delivery(await p.hugeTenant()) },
      ],
      run: (ctx, job) =>
        webhookDeliveryOps({
          db: ctx.db,
          secrets: { open: async () => "secret" } as never,
        }).load(job),
    },
  ),
  entry<number>({
    name: "scheduled.webhook_deliveries_due",
    area: "scheduled",
    site: {
      file: "apps/api/src/webhooks/db.ts",
      anchor: "export async function dueDeliveries(",
    },
    source: "code",
    frequency: "every few seconds (the delivery sweep)",
    role: "i10_api",
    cases: [{ name: "500 due", arg: async () => 500 }],
    run: (ctx, limit) => dueDeliveries(ctx.db, 60, limit),
  }),
  entry<number>({
    name: "scheduled.webhook_health_unfanned",
    area: "scheduled",
    site: {
      file: "apps/api/src/webhooks/health.ts",
      anchor: "export async function unfannedHealthEvents(",
    },
    source: "code",
    frequency: "every minute",
    role: "i10_api",
    cases: [{ name: "100", arg: async () => 100 }],
    run: (ctx, limit) => unfannedHealthEvents(ctx.db, limit),
  }),

  // --- the console and GET /emails ------------------------------------------
  entry<{ tenant: string; id: string }>({
    name: "api.get_email",
    area: "api",
    site: { file: "apps/api/src/send/lookup.ts", anchor: "async get(tenantId, id)" },
    source: "code",
    frequency: "every GET /emails/:id (customers poll it after sending)",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant, recent",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return { tenant: t, id: (await p.recentMessage(t)).id }
        },
        expect: (r) => (r ? null : "not found"),
      },
      {
        name: "huge tenant, oldest",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return { tenant: t, id: (await p.oldMessage(t)).id }
        },
        expect: (r) => (r ? null : "not found"),
      },
      {
        name: "missing",
        arg: async () => ({ tenant: FIXTURE_TENANTS.empty, id: MISSING_UUID }),
      },
    ],
    run: (ctx, a) => emailLookup(ctx.db).get(a.tenant, a.id),
  }),
  entry<{ tenant: string; filters: Record<string, unknown> }>({
    name: "console.list_emails",
    area: "console",
    site: {
      file: "apps/api/src/console/queries.ts",
      anchor: "async listEmails(tenantId, filters)",
    },
    source: "code",
    frequency: "every load of the Emails page and every page of it (also GET /emails)",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant, first page",
        arg: async (p) => ({ tenant: await p.hugeTenant(), filters: { limit: 50 } }),
      },
      {
        name: "huge tenant, status bounced",
        arg: async (p) => ({
          tenant: await p.hugeTenant(),
          filters: { limit: 50, status: ["bounced"] },
        }),
      },
      {
        name: "huge tenant, search",
        arg: async (p) => ({
          tenant: await p.hugeTenant(),
          filters: { limit: 50, search: "amira" },
        }),
      },
      {
        name: "huge tenant, last 7 days by key",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return {
            tenant: t,
            filters: { limit: 50, from: days(7), apiKeyId: await p.apiKeyId(t) },
          }
        },
      },
      {
        name: "median tenant",
        arg: async (p) => ({ tenant: await p.medianTenant(), filters: { limit: 50 } }),
      },
      {
        name: "empty tenant",
        arg: async (p) => ({ tenant: await p.emptyTenant(), filters: { limit: 50 } }),
      },
    ],
    run: (ctx, a) => consoleQueries(ctx.db).listEmails(a.tenant, a.filters as never),
  }),
  entry<{ tenant: string; id: string }>({
    name: "console.email_detail",
    area: "console",
    site: {
      file: "apps/api/src/console/queries.ts",
      anchor: "async emailDetail(tenantId, id)",
    },
    source: "code",
    frequency: "every open of one email",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant, recent",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return { tenant: t, id: (await p.recentMessage(t)).id }
        },
      },
      {
        name: "huge tenant, oldest",
        arg: async (p) => {
          const t = await p.hugeTenant()
          return { tenant: t, id: (await p.oldMessage(t)).id }
        },
      },
    ],
    run: (ctx, a) => consoleQueries(ctx.db).emailDetail(a.tenant, a.id),
  }),
  entry<{ tenant: string; days: number }>({
    name: "console.overview",
    area: "console",
    site: {
      file: "apps/api/src/console/queries.ts",
      anchor: "async overview(tenantId, days)",
    },
    source: "code",
    frequency: "every load of the console home",
    role: "i10_api",
    cases: [
      {
        name: "huge tenant, 30 days",
        arg: async (p) => ({ tenant: await p.hugeTenant(), days: 30 }),
      },
      {
        name: "median tenant, 7 days",
        arg: async (p) => ({ tenant: await p.medianTenant(), days: 7 }),
      },
      {
        name: "empty tenant",
        arg: async (p) => ({ tenant: await p.emptyTenant(), days: 30 }),
      },
    ],
    run: (ctx, a) => consoleQueries(ctx.db).overview(a.tenant, a.days),
  }),
  entry<{ tenant: string; status?: string }>({
    name: "console.list_deliveries",
    area: "console",
    site: {
      file: "apps/api/src/console/queries.ts",
      anchor: "async listDeliveries(tenantId, opts)",
    },
    source: "code",
    frequency: "every load of the webhook log",
    role: "i10_api",
    cases: [
      { name: "huge tenant", arg: async (p) => ({ tenant: await p.hugeTenant() }) },
      {
        name: "huge tenant, failed",
        arg: async (p) => ({ tenant: await p.hugeTenant(), status: "failed" }),
      },
    ],
    run: (ctx, a) =>
      consoleQueries(ctx.db).listDeliveries(a.tenant, {
        status: a.status,
        limit: 50,
      } as never),
  }),
  entry<{ tenant: string; status?: "ok" | "error" }>({
    name: "console.list_requests",
    area: "console",
    site: {
      file: "apps/api/src/console/queries.ts",
      anchor: "async listRequests(tenantId, opts)",
    },
    source: "code",
    frequency: "every load of the request log",
    role: "i10_api",
    cases: [
      { name: "huge tenant", arg: async (p) => ({ tenant: await p.hugeTenant() }) },
      {
        name: "huge tenant, errors",
        arg: async (p) => ({ tenant: await p.hugeTenant(), status: "error" }),
      },
    ],
    run: (ctx, a) =>
      consoleQueries(ctx.db).listRequests(a.tenant, { status: a.status, limit: 50 }),
  }),
  entry<string>({
    name: "console.count_shapes",
    area: "console",
    site: {
      file: "apps/api/src/console/queries.ts",
      anchor: "async countShapes(tenantId)",
    },
    source: "code",
    frequency: "every console page load (which skeleton to draw)",
    role: "i10_api",
    cases: [
      { name: "huge tenant", arg: (p) => p.hugeTenant() },
      { name: "empty tenant", arg: (p) => p.emptyTenant() },
    ],
    run: (ctx, tenant) => consoleQueries(ctx.db).countShapes(tenant),
  }),
  entry<string>({
    name: "console.mailboxes_list",
    area: "console",
    site: {
      file: "apps/api/src/mailboxes/console.ts",
      anchor: "async list({ tenantId, onlyUserId, limit, cursor })",
    },
    source: "code",
    frequency: "every load of the Mailboxes page",
    role: "i10_api",
    cases: [
      { name: "huge tenant", arg: (p) => p.hugeTenant() },
      { name: "sso tenant", arg: (p) => p.ssoTenant() },
      { name: "mixed-case domain", arg: async () => FIXTURE_TENANTS.mixedCase },
    ],
    run: (ctx, tenant) =>
      consoleMailboxStore(ctx.db).list({ tenantId: tenant, limit: 50 } as never),
  }),

  // --- scheduled jobs and the mail domain functions -------------------------
  entry<string | null>({
    name: "mail.domain_settings",
    area: "scheduled",
    site: {
      file: "apps/api/src/mail-domains-reconcile.ts",
      anchor: "core.mailbox_domain_settings()",
    },
    source: "call-text",
    frequency:
      "the mail domain reconcile CronJob (all names); the same function, by name, runs inside every authd bind",
    role: "i10_api",
    cases: [
      { name: "all names", arg: async () => null },
      { name: "one name", arg: (p) => p.hugeTenant().then((t) => p.hostedDomain(t)) },
    ],
    run: (ctx, name) =>
      name === null
        ? ctx.db.execute(
            sql`select name, catch_all_address from core.mailbox_domain_settings()`,
          )
        : ctx.db.execute(
            sql`select name, catch_all_address from core.mailbox_domain_settings(${name})`,
          ),
  }),
  entry<number>({
    name: "scheduled.unshipped_meter_events",
    area: "scheduled",
    site: {
      file: "apps/api/src/metering/ingest.ts",
      anchor: "export const unshippedStatement",
    },
    source: "code",
    frequency: "every minute (usage flush to Polar)",
    role: "i10_api",
    cases: [{ name: "1000", arg: async () => 1000 }],
    run: (ctx, limit) => ctx.db.execute(unshippedStatement("emails", limit)),
  }),
  entry<number>({
    name: "scheduled.retention_due",
    area: "scheduled",
    site: { file: "apps/api/src/retention.ts", anchor: "core.retention_due(" },
    source: "call-text",
    frequency: "the retention CronJob (hourly)",
    role: "i10_api",
    cases: [{ name: "floor 3 days", arg: async () => 3 }],
    run: (ctx, floor) =>
      ctx.db.execute(
        sql`select tenant_id, retention_days from core.retention_due(${floor})`,
      ),
  }),
  entry<number>({
    name: "scheduled.mailbox_jobs_lost",
    area: "scheduled",
    site: {
      file: "apps/api/src/mailboxes/sweep.ts",
      anchor: "async lost(after, limit)",
    },
    source: "code",
    frequency: "the mailbox job sweep (every few minutes)",
    role: "i10_api",
    cases: [{ name: "100", arg: async () => 100 }],
    run: (ctx, limit) =>
      mailboxSweepStore(ctx.db).lost("00000000-0000-0000-0000-000000000000", limit),
  }),
]
