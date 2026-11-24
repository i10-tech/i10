/**
 * Hand-written rows, each aimed at one risk, loaded on top of any profile.
 *
 * Every fixture tenant has a `fixture-` slug and a fixed id, so the registry's
 * parameter pickers and the generator's tests can name them. The ids sort
 * before anything the generator mints (it starts at 0190... v7 timestamps), so
 * they never collide.
 */
import type { Sql } from "postgres"

export interface Fixture {
  /** What it targets, in one line; the tests assert each is present. */
  risk: string
  /** A query (as the owner) that returns a row exactly when the fixture is in place. */
  check: string
}

const T = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`
export const FIXTURE_TENANTS = {
  empty: T(1),
  mixedCase: T(2),
  claimant: T(3),
  unicode: T(4),
  deleted: T(5),
  suspended: T(6),
  everyGate: T(7),
  longValues: T(8),
} as const

const LONG_LOCAL = "l".repeat(64)
const LONG_DOMAIN = `${"d".repeat(63)}.${"e".repeat(63)}.example`

export const FIXTURES: Fixture[] = [
  {
    risk: "a workspace with nothing in it: no domains, keys, mail or members beyond its owner",
    check: `select 1 from core.tenants t where t.id = '${FIXTURE_TENANTS.empty}' and not exists (select 1 from core.domains where tenant_id = t.id)`,
  },
  {
    risk: "a verified, mail-hosting domain enforced lowercase by domains_name_lowercase CHECK",
    check: `select 1 from core.domains d join pg_constraint c on c.conname = 'domains_name_lowercase' and c.convalidated where d.name = 'mixedcase.example' and d.status = 'verified' and d.hosts_mailboxes`,
  },
  {
    risk: "a mailbox on that domain, stored lowercase as the projection writes it",
    check: `select 1 from authd.accounts where email = 'ceo@mixedcase.example' and active`,
  },
  {
    risk: "an alias enforced lowercase by aliases_address_lowercase CHECK",
    check: `select 1 from authd.aliases al join pg_constraint c on c.conname = 'aliases_address_lowercase' and c.convalidated where al.address = 'sales@mixedcase.example'`,
  },
  {
    risk: "a team inbox address enforced lowercase by groups_email_lowercase CHECK",
    check: `select 1 from authd.groups g join pg_constraint c on c.conname = 'groups_email_lowercase' and c.convalidated where g.email = 'support@mixedcase.example'`,
  },
  {
    risk: "a second workspace claiming the same name, unverified",
    check: `select 1 from core.domains where name = 'mixedcase.example' and tenant_id = '${FIXTURE_TENANTS.claimant}' and status = 'pending'`,
  },
  {
    risk: "two contacts in one workspace that differ only in case",
    check: `select 1 from core.contacts where tenant_id = '${FIXTURE_TENANTS.mixedCase}' and lower(email) = 'ann@example.test' having count(*) = 2`,
  },
  {
    risk: "a suppression enforced lowercase by suppressions_address_lowercase CHECK",
    check: `select 1 from core.suppressions s join pg_constraint c on c.conname = 'suppressions_address_lowercase' and c.convalidated where s.tenant_id = '${FIXTURE_TENANTS.mixedCase}' and s.address = 'bob@example.test'`,
  },
  {
    risk: "a workspace and member named in RTL script, emoji and combining marks",
    check: `select 1 from core.tenants where id = '${FIXTURE_TENANTS.unicode}' and name ~ '[؀-ۿ]'`,
  },
  {
    risk: "a deleted workspace that still has domains, keys and mail",
    check: `select 1 from core.tenants t where t.id = '${FIXTURE_TENANTS.deleted}' and t.status = 'deleted' and exists (select 1 from core.messages m where m.tenant_id = t.id)`,
  },
  {
    risk: "a suspended workspace with a live API key",
    check: `select 1 from core.api_keys where tenant_id = '${FIXTURE_TENANTS.suspended}' and revoked_at is null`,
  },
  {
    risk: "a mailbox with every gate set at once: suspended, payment hold, deleting, banned, locked forever, SSO required and exempt",
    check: `select 1 from authd.accounts a join authd.required_exempt x on x.clerk_user_id = a.clerk_user_id where a.email = 'all.gates@gates.example' and a.suspended_at is not null and a.payment_hold_at is not null and a.deleting_at is not null and a.banned and a.locked and a.locked_until is null`,
  },
  {
    risk: "the longest legal address (64 character local part, 63 character labels) and a 998 character subject",
    check: `select 1 from core.messages where tenant_id = '${FIXTURE_TENANTS.longValues}' and length(subject) = 998 and cardinality(to_addresses) = 50`,
  },
  {
    risk: "an API key that is both revoked and expired, and one that never expires",
    check: `select 1 from core.api_keys where tenant_id = '${FIXTURE_TENANTS.suspended}' and revoked_at is not null and expires_at < revoked_at`,
  },
  {
    risk: "a polling endpoint (no URL) and a message scheduled a year out",
    check: `select 1 from core.webhook_endpoints e join core.messages m on m.tenant_id = e.tenant_id where e.tenant_id = '${FIXTURE_TENANTS.longValues}' and e.url is null and m.scheduled_at > m.created_at + interval '300 days'`,
  },
]

/** Fixed ids for the fixture rows other rows point at, so two loads are identical. */
const R = (n: number) => `00000000-0000-7000-8001-${n.toString(16).padStart(12, "0")}`

/**
 * Loads the fixtures. Every id is fixed and every time is relative to `anchor`
 * (the seed's "now"), never the clock, so the determinism test covers them too.
 */
export async function loadFixtures(sql: Sql, anchor: Date): Promise<void> {
  const F = FIXTURE_TENANTS
  const at = (days: number) => new Date(anchor.getTime() + days * 86_400_000)
  await sql.begin(async (tx) => {
    const tenant = (
      id: string,
      slug: string,
      name: string,
      status = "active",
      org: string | null = `org_fixture_${slug}`,
    ) =>
      tx`insert into core.tenants (id, slug, name, clerk_org_id, owner_clerk_user_id, status)
         values (${id}, ${"fixture-" + slug}, ${name}, ${org}, ${"user_fixture_" + slug}, ${status})`
    await tenant(F.empty, "empty", "Empty", "active", null)
    await tenant(F.mixedCase, "mixed-case", "Mixed Case Inc")
    await tenant(F.claimant, "claimant", "Claimant")
    await tenant(F.unicode, "unicode", "شركة النيل 🚀 Zoë")
    await tenant(F.deleted, "deleted", "Deleted Co", "deleted")
    await tenant(F.suspended, "suspended", "Suspended Co", "suspended")
    await tenant(F.everyGate, "every-gate", "Every Gate")
    await tenant(F.longValues, "long-values", "L".repeat(500))
    for (const [id, slug] of Object.entries(F)) {
      await tx`insert into core.workspace_roles (tenant_id, clerk_user_id, role, source)
               values (${F[id as keyof typeof F]}, ${"user_fixture_" + slug.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}, 'owner', 'clerk')
               on conflict do nothing`
    }
    await tx`insert into core.workspace_roles (tenant_id, clerk_user_id, role, source)
             values (${F.unicode}, 'user_fixture_unicode_member', 'member', 'clerk')`

    const assertRefused = async (
      label: string,
      run: (sp: typeof tx) => Promise<unknown>,
    ) => {
      try {
        await tx.savepoint(async (sp) => {
          await run(sp)
          throw new Error(
            `expected CHECK constraint to refuse mixed-case write: ${label}`,
          )
        })
      } catch (err) {
        if ((err as { code?: unknown }).code === "23514") return
        throw err
      }
    }

    const domain = (
      id: string,
      tenant: string,
      name: string,
      status: string,
      hosts: boolean,
      db: typeof tx = tx,
    ) =>
      db`insert into core.domains (id, tenant_id, name, status, hosts_mailboxes, verified_at, created_at, updated_at)
         values (${id}, ${tenant}, ${name}, ${status}::core.domain_status, ${hosts}, ${status === "verified" ? at(-1) : null}, ${at(-2)}, ${at(-2)})`
    await assertRefused("core.domains.name", (sp) =>
      domain(R(1), F.mixedCase, "MixedCase.Example", "verified", true, sp),
    )
    await domain(R(1), F.mixedCase, "mixedcase.example", "verified", true)
    await domain(R(2), F.claimant, "mixedcase.example", "pending", false)
    await domain(R(3), F.everyGate, "gates.example", "verified", true)
    await domain(R(4), F.deleted, "deleted.example", "verified", false)
    await domain(R(5), F.longValues, LONG_DOMAIN, "verified", false)
    await domain(R(6), F.unicode, "xn--mgbh0fb.example", "verified", false)

    await tx`insert into authd.accounts (clerk_user_id, email, active, tenant_id) values
             ('user_fixture_mixed-case', 'ceo@mixedcase.example', true, ${F.mixedCase})`
    await assertRefused(
      "authd.aliases.address",
      (sp) =>
        sp`insert into authd.aliases (address, clerk_user_id, source) values ('Sales@mixedcase.example', 'user_fixture_mixed-case', 'console')`,
    )
    await tx`insert into authd.aliases (address, clerk_user_id, source) values ('sales@mixedcase.example', 'user_fixture_mixed-case', 'console')`
    await assertRefused(
      "authd.groups.email",
      (sp) =>
        sp`insert into authd.groups (name, email, tenant_id) values ('fixture-support', 'Support@MixedCase.Example', ${F.mixedCase})`,
    )
    await tx`insert into authd.groups (name, email, tenant_id) values ('fixture-support', 'support@mixedcase.example', ${F.mixedCase})`
    await tx`insert into authd.group_members (group_name, clerk_user_id) values ('fixture-support', 'user_fixture_mixed-case')`

    // Every gate at once, on a domain that requires SSO, with the person exempt from it.
    const conn = { id: R(7) }
    await tx`insert into identity.connections (id, tenant_id, name, protocol, status, enforcement)
             values (${conn.id}, ${F.everyGate}, 'Fixture SSO', 'saml', 'active', 'required_all')`
    await tx`insert into authd.accounts (clerk_user_id, email, active, tenant_id, suspended_at, payment_hold_at, deleting_at, banned, locked)
             values ('user_fixture_every-gate', 'all.gates@gates.example', true, ${F.everyGate}, ${at(-1)}, ${at(-1)}, ${at(-1)}, true, true)`
    await tx`insert into core.mailbox_deletions (tenant_id, clerk_user_id, address, outcome, requested_by, deleting_at, purge_after)
             values (${F.everyGate}, 'user_fixture_every-gate', 'all.gates@gates.example', 'delete', 'user_fixture_every-gate', ${at(-1)}, ${at(29)})`
    await tx`insert into authd.required_domains (domain, tenant_id, connection_id) values ('gates.example', ${F.everyGate}, ${conn.id})`
    await tx`insert into authd.required_exempt (connection_id, tenant_id, clerk_user_id, source)
             values (${conn.id}, ${F.everyGate}, 'user_fixture_every-gate', 'owner_exemption')`
    await tx`insert into identity.managed_accounts (clerk_user_id, tenant_id, connection_id, reason, emails)
             values ('user_fixture_every-gate', ${F.everyGate}, ${conn.id}, 'scim', ${["all.gates@gates.example"]})`
    await tx`insert into authd.managed_accounts (clerk_user_id, connection_id) values ('user_fixture_every-gate', ${conn.id})`

    await tx`insert into core.contacts (tenant_id, email) values (${F.mixedCase}, 'Ann@Example.test'), (${F.mixedCase}, 'ann@example.test')`
    await assertRefused(
      "core.suppressions.address",
      (sp) =>
        sp`insert into core.suppressions (tenant_id, address, reason) values (${F.mixedCase}, 'Bob@Example.test', 'manual')`,
    )
    await tx`insert into core.suppressions (tenant_id, address, reason) values (${F.mixedCase}, 'bob@example.test', 'manual')`

    await tx`insert into core.api_keys (id, tenant_id, name, prefix, mode, secret_hash, revoked_at, expires_at) values
             (${R(8)}, ${F.suspended}, 'live', 'i10_live_', 'live', ${"f".repeat(63) + "1"}, null, null),
             (${R(9)}, ${F.suspended}, 'dead', 'i10_live_', 'live', ${"f".repeat(63) + "2"}, ${at(-1)}, ${at(-2)}),
             (${R(10)}, ${F.deleted}, 'orphan', 'i10_live_', 'live', ${"f".repeat(63) + "3"}, null, null)`

    const message = (
      id: string,
      tenant: string,
      domainId: string,
      from: string,
      to: string[],
      subject: string,
      scheduled: Date | null,
    ) =>
      tx`insert into core.messages (id, created_at, tenant_id, domain_id, from_address, to_addresses, subject, status, scheduled_at)
         values (${id}, ${anchor}, ${tenant}, ${domainId}, ${from}, ${to}, ${subject}, 'queued', ${scheduled})`
    await message(
      R(11),
      F.deleted,
      R(4),
      "noreply@deleted.example",
      ["x@example.test"],
      "Left behind",
      null,
    )
    const longAddress = `${LONG_LOCAL}@${LONG_DOMAIN}`
    await message(
      R(12),
      F.longValues,
      R(5),
      longAddress,
      Array.from(
        { length: 50 },
        (_, i) => `${LONG_LOCAL.slice(2)}${String(i).padStart(2, "0")}@${LONG_DOMAIN}`,
      ),
      "S".repeat(998),
      at(360),
    )
    await tx`insert into core.webhook_endpoints (id, tenant_id, url, secret_ciphertext, events, kind)
             values (${R(13)}, ${F.longValues}, null, 'v1.fixture', '{email.sent}', 'polling')`
  })
}

/** Returns the fixtures whose check finds no row: empty when every one is in place. */
export async function missingFixtures(sql: Sql): Promise<string[]> {
  const missing: string[] = []
  for (const f of FIXTURES) {
    const rows = await sql.unsafe(f.check)
    if (rows.length === 0) missing.push(f.risk)
  }
  return missing
}
