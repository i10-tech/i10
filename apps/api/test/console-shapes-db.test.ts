import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import type { Database } from "../src/db/client.js"
import { consoleQueries } from "../src/console/queries.js"

/**
 * Verifies countShapes against a real PostgreSQL database with RLS.
 *
 *   TEMPLATES_TEST_DATABASE_URL=postgres://i10:i10@localhost:5433/templates_scratch bun test test/console-shapes-db.test.ts
 */
const URL = process.env.TEMPLATES_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

let owner: ReturnType<typeof postgres>
let db: ReturnType<typeof postgres>
let database: Database
let tenantA: string
let tenantB: string
// ⚠ A SCRATCH DATABASE MAY PREDATE THE DIRECTORIES TABLE; its count is then asserted absent.
let hasDirectories = false

suite("console shapes db queries", () => {
  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    db = postgres(API_URL!, { max: 4, onnotice: () => {} })
    database = drizzle({ client: db }) as unknown as Database

    tenantA = crypto.randomUUID()
    tenantB = crypto.randomUUID()

    await owner`insert into core.tenants (id, slug, name, owner_clerk_user_id)
                values (${tenantA}, ${`sa-${tenantA.slice(0, 8)}`}, 'A', ${`user-${tenantA}`}),
                       (${tenantB}, ${`sb-${tenantB.slice(0, 8)}`}, 'B', ${`user-${tenantB}`})`

    // ──────────────────────────────────────────────────────────────────────────
    // tenantA rows: seeded with varying statuses/flags to prove unfiltered inclusion
    // ──────────────────────────────────────────────────────────────────────────

    // Domains: verified, pending, and displaced (displaced_at is set, not hidden)
    await owner`insert into core.domains (tenant_id, name, status, displaced_at)
                values (${tenantA}, 'a.test', 'verified', null),
                       (${tenantA}, 'b.test', 'pending', null),
                       (${tenantA}, 'c.test', 'verified', now())`

    // API keys: active and revoked (unfiltered list includes revoked)
    await owner`insert into core.api_keys (tenant_id, name, prefix, secret_hash, mode, scopes, revoked_at)
                values (${tenantA}, 'k1', 'k1_', 'h1', 'live', '{}', null),
                       (${tenantA}, 'k2', 'k2_', 'h2', 'live', '{}', now())`

    // Suppressions: hard_bounce and manual (all reasons shown unfiltered)
    await owner`insert into core.suppressions (tenant_id, address, reason)
                values (${tenantA}, 'sup1@acme.test', 'hard_bounce'),
                       (${tenantA}, 'sup2@acme.test', 'manual')`

    // Contacts: subscribed and unsubscribed (unfiltered list shows both)
    await owner`insert into core.contacts (tenant_id, email, unsubscribed)
                values (${tenantA}, 'c1@acme.test', false),
                       (${tenantA}, 'c2@acme.test', false),
                       (${tenantA}, 'c3@acme.test', true)`

    // Segments: empty segment (unfiltered list shows empty segments)
    await owner`insert into core.segments (tenant_id, name)
                values (${tenantA}, 'Newsletter')`

    // Topics: opt_in and opt_out (unfiltered list shows both)
    await owner`insert into core.topics (tenant_id, name, default_subscription)
                values (${tenantA}, 'Updates', 'opt_in'),
                       (${tenantA}, 'Alerts', 'opt_out')`

    // Broadcasts: draft and sent (unfiltered list shows all statuses)
    await owner`insert into core.broadcasts (tenant_id, name, from_address, subject, status)
                values (${tenantA}, 'Welcome', 'hi@a.test', 'Hello', 'draft'),
                       (${tenantA}, 'News', 'hi@a.test', 'News', 'sent')`

    // Webhook endpoints: one healthy, one failing and on, one failing but paused by
    // the customer (the banner skips it), one switched off by i10.
    await owner`insert into core.webhook_endpoints (tenant_id, url, secret_ciphertext, events, health, enabled)
                values (${tenantA}, 'https://hook.test/1', 'x', '{email.sent}', 'healthy', true),
                       (${tenantA}, 'https://hook.test/2', 'x', '{email.sent}', 'failing', true),
                       (${tenantA}, 'https://hook.test/3', 'x', '{email.sent}', 'failing', false),
                       (${tenantA}, 'https://hook.test/4', 'x', '{email.sent}', 'disabled', false)`

    // Template folders & templates:
    // folder 1
    const [folderA] = await owner`insert into core.template_folders (tenant_id, name)
                                  values (${tenantA}, 'Transactional')
                                  returning id`
    // a folder inside it: drawn on its parent's page, so the top level ignores it
    await owner`insert into core.template_folders (tenant_id, name, parent_id)
                values (${tenantA}, 'Auth', ${folderA!.id})`
    // top-level template (folder_id is null)
    await owner`insert into core.templates (tenant_id, name, folder_id, kind, source)
                values (${tenantA}, 'top1', null, 'html', 'upload')`
    // template filed in folder (HIDDEN from top-level /console/templates)
    await owner`insert into core.templates (tenant_id, name, folder_id, kind, source)
                values (${tenantA}, 'inside-folder', ${folderA!.id}, 'html', 'upload')`

    // Reviewed templates, GitHub, SSO: the rest of the templates and SSO skeletons.
    await owner`insert into core.trusted_templates (tenant_id, name, skeleton_hash, segments, holes, bands, submitted_by)
                values (${tenantA}, 'reset', 'h1', '[]'::jsonb, '[]'::jsonb, '{}', 'u1'),
                       (${tenantA}, 'receipt', 'h2', '[]'::jsonb, '[]'::jsonb, '{}', 'u1')`
    const installA = Math.floor(Math.random() * 1e9) + 1
    await owner`insert into core.github_installations (tenant_id, installation_id, account_login, account_type)
                values (${tenantA}, ${installA}, 'acme', 'Organization')`
    await owner`insert into core.github_repositories (tenant_id, installation_id, repo_id, full_name)
                values (${tenantA}, ${installA}, ${installA}, 'acme/a'),
                       (${tenantA}, ${installA}, ${installA + 1}, 'acme/b')`
    await owner`insert into identity.connections (tenant_id, name, protocol)
                values (${tenantA}, 'Okta', 'oidc'), (${tenantA}, 'Entra', 'saml')`
    hasDirectories =
      (await owner`select to_regclass('identity.directories') as t`)[0]!.t !== null
    if (hasDirectories) {
      await owner`insert into identity.directories (tenant_id, name, provider)
                  values (${tenantA}, 'Okta SCIM', 'okta')`
    }

    // 14 messages on tenantA (capped at 10)
    for (let i = 0; i < 14; i++) {
      const status = i % 2 === 0 ? "sent" : "failed"
      await owner`insert into core.messages (tenant_id, from_address, to_addresses, subject, status)
                  values (${tenantA}, 'hi@a.test', '{to@test.com}', ${`msg ${i}`}, ${status})`
    }

    // 3 api_requests on tenantA (status 200 and 500)
    await owner`insert into core.api_requests (tenant_id, method, path, status, duration_ms, occurred_at)
                values (${tenantA}, 'GET', '/domains', 200, 10, now()),
                       (${tenantA}, 'POST', '/emails', 500, 25, now()),
                       (${tenantA}, 'GET', '/api-keys', 200, 5, now())`

    // ──────────────────────────────────────────────────────────────────────────
    // tenantB rows: HIDDEN from tenantA (cross-tenant isolation test)
    // ──────────────────────────────────────────────────────────────────────────
    await owner`insert into core.domains (tenant_id, name, status) values (${tenantB}, 'b-dom.test', 'verified')`
    await owner`insert into core.api_keys (tenant_id, name, prefix, secret_hash, mode, scopes)
                values (${tenantB}, 'kb', 'kb_', 'hb', 'live', '{}')`
    await owner`insert into core.suppressions (tenant_id, address, reason)
                values (${tenantB}, 'sup-b@acme.test', 'hard_bounce')`
    await owner`insert into core.contacts (tenant_id, email, unsubscribed)
                values (${tenantB}, 'cb@acme.test', false)`
    await owner`insert into core.segments (tenant_id, name) values (${tenantB}, 'Seg B')`
    await owner`insert into core.topics (tenant_id, name) values (${tenantB}, 'Topic B')`
    await owner`insert into core.broadcasts (tenant_id, name, from_address, subject)
                values (${tenantB}, 'Bcast B', 'hi@b-dom.test', 'B')`
    await owner`insert into core.webhook_endpoints (tenant_id, url, secret_ciphertext, events)
                values (${tenantB}, 'https://hook.test/b', 'xb', '{email.sent}')`
    await owner`insert into core.template_folders (tenant_id, name) values (${tenantB}, 'Folder B')`
    await owner`insert into core.templates (tenant_id, name, folder_id, kind, source)
                values (${tenantB}, 'topB', null, 'html', 'upload')`
    await owner`insert into core.messages (tenant_id, from_address, to_addresses, subject, status)
                values (${tenantB}, 'hi@b-dom.test', '{b@test.com}', 'msg b', 'sent')`
    await owner`insert into core.api_requests (tenant_id, method, path, status, duration_ms, occurred_at)
                values (${tenantB}, 'GET', '/domains', 200, 10, now())`
  })

  afterAll(async () => {
    if (owner) {
      await owner`delete from core.tenants where id in (${tenantA}, ${tenantB})`
      await owner.end()
    }
    if (db) await db.end()
  })

  it("counts accurately under tenant RLS in one query and ignores hidden rows", async () => {
    const queries = consoleQueries(database)
    const counts = await queries.countShapes(tenantA)

    // domains: 3 on tenantA (verified, pending, displaced). Ignores tenantB domain.
    expect(counts.domains).toBe(3)
    // apiKeys: 2 on tenantA (includes revoked k2). Ignores tenantB key.
    expect(counts.apiKeys).toBe(2)
    // suppressions: 2 on tenantA (hard_bounce, manual). Ignores tenantB suppression.
    expect(counts.suppressions).toBe(2)
    // contacts: 3 on tenantA (subscribed and unsubscribed). Ignores tenantB contact.
    expect(counts.contacts).toBe(3)
    // segments: 1 on tenantA. Ignores tenantB segment.
    expect(counts.segments).toBe(1)
    // topics: 2 on tenantA (opt_in, opt_out). Ignores tenantB topic.
    expect(counts.topics).toBe(2)
    // broadcasts: 2 on tenantA (draft, sent). Ignores tenantB broadcast.
    expect(counts.broadcasts).toBe(2)
    // webhooks: 4 on tenantA. Ignores tenantB webhook.
    expect(counts.webhooks).toBe(4)
    // The banner's own condition: switched off, and failing while still on.
    expect(counts.webhooksDisabled).toBe(1)
    expect(counts.webhooksFailing).toBe(1)
    // Distinct statuses, displaced apart: verified, pending, displaced; draft, sent.
    expect(counts.domainStatuses).toBe(3)
    expect(counts.broadcastStatuses).toBe(2)
    // templates: 1 top-level, apart from the folder. The one filed in a folder is IGNORED, and tenantB is IGNORED.
    expect(counts.templates).toBe(1)
    // template folders: the top-level one; the folder inside it is IGNORED.
    expect(counts.templateFolders).toBe(1)
    expect(counts.trustedTemplates).toBe(2)
    expect(counts.githubInstallations).toBe(1)
    expect(counts.githubRepos).toBe(2)
    // SSO: connections 2 and (when the table exists) directories 1; tenantB has none.
    expect(counts.ssoConnections).toBe(2)
    expect(counts.ssoDirectories).toBe(hasDirectories ? 1 : undefined)
    // emails: 14 messages on tenantA (sent, failed) capped at 10. Ignores tenantB message.
    expect(counts.emails).toBe(10)
    // logs: 3 requests on tenantA (status 200, 500). Ignores tenantB request.
    expect(counts.logs).toBe(3)
  })

  it("isolates tenant data under RLS (tenantB counts only its own rows)", async () => {
    const queries = consoleQueries(database)
    const counts = await queries.countShapes(tenantB)

    // tenantB has exactly 1 of each, and nothing in the reviewed, GitHub or SSO tables
    expect(counts.domains).toBe(1)
    expect(counts.apiKeys).toBe(1)
    expect(counts.suppressions).toBe(1)
    expect(counts.contacts).toBe(1)
    expect(counts.segments).toBe(1)
    expect(counts.topics).toBe(1)
    expect(counts.broadcasts).toBe(1)
    expect(counts.webhooks).toBe(1)
    expect(counts.webhooksDisabled).toBe(0)
    expect(counts.webhooksFailing).toBe(0)
    // One domain and one broadcast: a single status each, so no filter.
    expect(counts.domainStatuses).toBe(1)
    expect(counts.broadcastStatuses).toBe(1)
    expect(counts.templates).toBe(1)
    expect(counts.templateFolders).toBe(1)
    expect(counts.trustedTemplates).toBe(0)
    expect(counts.githubInstallations).toBe(0)
    expect(counts.githubRepos).toBe(0)
    expect(counts.ssoConnections).toBe(0)
    expect(counts.emails).toBe(1)
    expect(counts.logs).toBe(1)
  })

  it("returns {} on query failure without throwing", async () => {
    const queries = consoleQueries(database)
    // Non-existent tenantId causes no error, but let's test invalid input that causes error or empty
    const counts = await queries.countShapes("00000000-0000-0000-0000-000000000000")
    // When 0 rows exist for that tenant, counts are all 0
    expect(counts.domains).toBe(0)
    expect(counts.templates).toBe(0)

    // Test when database transaction throws (e.g. invalid UUID syntax for tenantId)
    const failedCounts = await queries.countShapes("not-a-valid-uuid")
    expect(failedCounts).toEqual({})
  })
})
