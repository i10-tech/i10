import type { Sql } from "postgres"

/**
 * Every table in the database that deliberately has NO row-level security
 * (#383, docs/research/mail-device-binding.md section 10).
 *
 * ⚠ CI ENFORCES THIS LIST (`apps/api/scripts/check-migrations.ts`). Any new
 * table outside `core` or `identity` that does not enable RLS must either turn
 * RLS on or be added here with a one-line reason explaining what holds the
 * tenant boundary instead. Stale entries (tables that turned RLS on or were
 * dropped) also fail CI so the allowlist stays exact.
 *
 * ⚠ NOT RUN AT API BOOT (`assertRlsSubject` in `db/client.ts`): a migration can
 * land before pods roll, and a boot check against a static allowlist would
 * crash-loop pods during a rollout. CI against the migrated schema is the right
 * gate.
 */
export const NON_RLS_ALLOWLIST: Readonly<Record<string, string>> = {
  // authd: read across workspaces by the mail auth sidecar and mail front;
  // every API write and read filters by tenant in code.
  "authd.access_changes":
    "Cross-tenant revocation log read by mailfront; pruned hourly by retention.",
  "authd.accounts":
    "Cross-tenant mailbox projection read by authd and mailfront; API writes scope by tenant.",
  "authd.aliases":
    "Cross-tenant alias projection read by authd; API writes scope by tenant.",
  "authd.bind_failure_budget":
    "Per-account LDAP failure counter shared by authd pods; keyed by clerk_user_id.",
  "authd.group_members":
    "Cross-tenant mailing list membership read by authd; API writes scope by tenant.",
  "authd.group_sent_copies":
    "Cross-tenant group sent-copy metadata read by authd; API writes scope by tenant.",
  "authd.groups":
    "Cross-tenant mailing list projection read by authd; API writes scope by tenant.",
  "authd.mail_device_cert_binds":
    "Cross-tenant Mac liveness rows keyed by device id, written by authd and read by mailfront; no tenant column.",
  "authd.mail_device_cert_permits":
    "Read only by the API's CA webhook handlers, which look permits up by serial, nonce, key or challenge; PR 4's enrollment scopes writes by tenant.",
  "authd.mail_devices":
    "Read across workspaces by authd and mailfront; apps/api/src/mail-devices/ is the tenant boundary.",
  "authd.managed_accounts":
    "Cross-tenant SSO-managed account mirror read by authd; API writes scope by tenant.",
  "authd.passthrough_versions":
    "Cross-tenant connection version and active flag read by authd and mailfront.",
  "authd.required_domains":
    "Cross-tenant SSO-required domain mirror read by authd and mailfront.",
  "authd.required_exempt":
    "Cross-tenant SSO-requirement exemption mirror read by authd and mailfront.",
  "authd.webhook_events":
    "Clerk webhook delivery deduplication table; keyed by global svix_id.",

  // pdns: PowerDNS gpgsql backend schema read by the authoritative DNS server.
  "pdns.comments": "PowerDNS backend schema; no tenant session context.",
  "pdns.cryptokeys": "PowerDNS DNSSEC key store; no tenant session context.",
  "pdns.domainmetadata": "PowerDNS zone metadata; no tenant session context.",
  "pdns.domains": "PowerDNS zones read by authoritative DNS server.",
  "pdns.records": "PowerDNS resource records read by authoritative DNS server.",
  "pdns.supermasters": "PowerDNS supermasters table; no tenant session context.",
  "pdns.tsigkeys": "PowerDNS TSIG keys; no tenant session context.",

  // drizzle: migration runner bookkeeping table.
  "drizzle.__drizzle_migrations":
    "Drizzle migration journal; global database metadata.",
}

export interface RlsAllowlistResult {
  unlisted: string[]
  stale: string[]
}

/**
 * Compares the tables that currently lack RLS against `NON_RLS_ALLOWLIST`.
 * Exported as a pure function so unit tests can pin both failure directions.
 */
export function checkRlsAllowlist(
  unprotectedTables: readonly string[],
  allowlist: Readonly<Record<string, string>> = NON_RLS_ALLOWLIST,
): RlsAllowlistResult {
  const actual = new Set(unprotectedTables)
  const allowed = new Set(Object.keys(allowlist))
  const unlisted = [...actual].filter((t) => !allowed.has(t)).sort()
  const stale = [...allowed].filter((t) => !actual.has(t)).sort()
  return { unlisted, stale }
}

/**
 * Verifies against a migrated database that every non-system, non-extension
 * table without RLS is explicitly listed in `NON_RLS_ALLOWLIST`, and that no
 * entry in `NON_RLS_ALLOWLIST` is stale.
 */
export async function assertRlsAllowlist(
  sql_: Sql,
  allowlist: Readonly<Record<string, string>> = NON_RLS_ALLOWLIST,
): Promise<void> {
  const rows = await sql_<{ name: string }[]>`
    select (n.nspname || '.' || c.relname)::text as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname not in ('pg_catalog', 'information_schema')
       and n.nspname not like 'pg_%'
       and c.relkind in ('r', 'p')
       and not c.relrowsecurity
       and not exists (
         select 1 from pg_depend d
          where d.objid = c.oid and d.deptype = 'e'
       )
     order by 1
  `
  const { unlisted, stale } = checkRlsAllowlist(
    rows.map((r) => r.name),
    allowlist,
  )
  const problems = [
    unlisted.length > 0 &&
      `tables without RLS missing from NON_RLS_ALLOWLIST: ${unlisted.join(", ")}`,
    stale.length > 0 &&
      `stale NON_RLS_ALLOWLIST entries (table now has RLS or no longer exists): ${stale.join(", ")}`,
  ].filter(Boolean)

  if (problems.length > 0) {
    throw new Error(
      `RLS allowlist check failed: ${problems.join("; ")}. ` +
        `Either enable row-level security on the table or update apps/api/src/db/rls-allowlist.ts.`,
    )
  }
}
