/**
 * Parameter pickers: real values from the seeded database for each registry
 * case, including the worst ones (the huge tenant, the empty tenant, a row that
 * does not exist). Read as the owner, so they see every tenant; cached per run.
 */
import type { Sql } from "postgres"
import { FIXTURE_TENANTS } from "./fixtures.js"

export const MISSING_UUID = "01890000-0000-7000-8000-000000000000"

export class Pickers {
  private cache = new Map<string, unknown>()

  constructor(readonly sql: Sql) {}

  private async once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) this.cache.set(key, await fn())
    return this.cache.get(key) as T
  }

  private async one<T>(key: string, text: string, params: unknown[] = []): Promise<T> {
    return this.once(key, async () => {
      const rows = await this.sql.unsafe(text, params as never[])
      const row = rows[0] as Record<string, unknown> | undefined
      if (!row) throw new Error(`picker ${key} found nothing`)
      return Object.values(row)[0] as T
    })
  }

  /** The generator's tenant 0: a quarter of all mail, the most of everything. */
  hugeTenant = () =>
    this.one<string>(
      "huge",
      `select id::text from core.tenants where slug like '%-0' and slug not like 'fixture-%' order by created_at limit 1`,
    )

  /** A sending tenant at the median message count: the typical customer. */
  medianTenant = () =>
    this.one<string>(
      "median",
      `
      with c as (select tenant_id, count(*) n from core.messages group by 1)
      select tenant_id::text from c order by n, tenant_id offset (select count(*) / 2 from c) limit 1`,
    )

  emptyTenant = async () => FIXTURE_TENANTS.empty
  mixedCaseTenant = async () => FIXTURE_TENANTS.mixedCase
  missingTenant = async () => MISSING_UUID

  tenant = (kind: "huge" | "median" | "empty" | "missing") =>
    ({
      huge: this.hugeTenant,
      median: this.medianTenant,
      empty: this.emptyTenant,
      missing: this.missingTenant,
    })[kind]()

  /** An active mailbox in the huge tenant, on its busiest domain. */
  hugeAccount = () =>
    this.hugeTenant().then((t) =>
      this.one<string>(
        "hugeAccount",
        `select email from authd.accounts where tenant_id = $1 and active order by email limit 1`,
        [t],
      ),
    )

  /** A mailbox whose domain requires SSO, in the tenant that requires it. */
  ssoAccount = () =>
    this.one<string>(
      "ssoAccount",
      `
      select a.email from authd.accounts a
        join authd.required_domains rd on rd.domain = split_part(a.email, '@', 2) and rd.tenant_id = a.tenant_id
       where a.active order by a.email limit 1`,
    )

  aliasAddress = () =>
    this.one<string>(
      "alias",
      `select al.address from authd.aliases al join authd.accounts a using (clerk_user_id) where a.active and al.address = lower(al.address) order by al.address limit 1`,
    )

  accountId = (email: string) =>
    this.one<string>(
      `uid:${email}`,
      `select clerk_user_id from authd.accounts where email = $1`,
      [email],
    )

  /** Fifty mailboxes across tenants: one delivery to many local recipients. */
  manyAddresses = () =>
    this.once("many", async () =>
      (
        await this
          .sql`select email from authd.accounts where active order by md5(email) limit 50`
      ).map((r) => r.email as string),
    )

  hugeGroupEmail = () =>
    this.hugeTenant().then((t) =>
      this.one<string>(
        "hugeGroup",
        `select lower(email) from authd.groups where tenant_id = $1 order by name limit 1`,
        [t],
      ),
    )
  busyMember = () =>
    this.one<string>(
      "busyMember",
      `select clerk_user_id from authd.group_members group by 1 order by count(*) desc, 1 limit 1`,
    )
  groupNames = () =>
    this.once("groupNames", async () =>
      (await this.sql`select name from authd.groups order by name limit 20`).map(
        (r) => r.name as string,
      ),
    )

  liveKeyHash = (tenant: string) =>
    this.one<string>(
      `key:${tenant}`,
      `select secret_hash from core.api_keys where tenant_id = $1 and revoked_at is null order by created_at limit 1`,
      [tenant],
    )
  revokedKeyHash = () =>
    this.one<string>(
      "revoked",
      `select secret_hash from core.api_keys where revoked_at is not null order by created_at limit 1`,
    )

  /** The tenant's owner and organization, as Clerk would present them. */
  principal = (tenant: string) =>
    this.once(`principal:${tenant}`, async () => {
      const [r] = await this
        .sql`select owner_clerk_user_id u, clerk_org_id o from core.tenants where id = ${tenant}`
      return {
        userId: String(r?.u ?? "user_missing"),
        orgId: (r?.o as string | null) ?? null,
      }
    })

  /** A recent message of the tenant, or a missing id. */
  recentMessage = (tenant: string) =>
    this.once(`recent:${tenant}`, async () => {
      const [r] = await this
        .sql`select id::text, created_at from core.messages where tenant_id = ${tenant} order by created_at desc limit 1`
      return r
        ? { id: String(r.id), createdAt: new Date(r.created_at as Date) }
        : { id: MISSING_UUID, createdAt: new Date() }
    })

  /** A message from the far end of the history (a cold partition). */
  oldMessage = (tenant: string) =>
    this.once(`old:${tenant}`, async () => {
      const [r] = await this
        .sql`select id::text, created_at from core.messages where tenant_id = ${tenant} order by created_at limit 1`
      return r
        ? { id: String(r.id), createdAt: new Date(r.created_at as Date) }
        : { id: MISSING_UUID, createdAt: new Date() }
    })

  /**
   * `n` messages of the tenant as the send worker claims them: queued ones
   * first, topped up with its latest (which the claim then skips as not queued,
   * the same plan with fewer rows won).
   */
  queuedRefs = (tenant: string, n: number) =>
    this.once(`queued:${tenant}:${n}`, async () =>
      (
        await this
          .sql`select id::text, created_at from core.messages where tenant_id = ${tenant}
                       order by status not in ('queued', 'sending'), created_at desc limit ${n}`
      ).map((r) => ({ id: String(r.id), createdAt: new Date(r.created_at as Date) })),
    )

  sendingDomains = (tenant: string) =>
    this.once(`sending:${tenant}`, async () =>
      (
        await this
          .sql`select lower(name) n from core.domains where tenant_id = ${tenant} and status = 'verified' order by name limit 3`
      ).map((r) => r.n as string),
    )

  /** Recipients of the tenant's recent mail, some of them suppressed. */
  recipients = (tenant: string, n: number) =>
    this.once(`rcpt:${tenant}:${n}`, async () => {
      const sup = (
        await this
          .sql`select address from core.suppressions where tenant_id = ${tenant} order by created_at desc limit ${Math.ceil(n / 5)}`
      ).map((r) => r.address as string)
      const to = (
        await this
          .sql`select to_addresses[1] a from core.messages where tenant_id = ${tenant} order by created_at desc limit ${n - sup.length}`
      ).map((r) => r.a as string)
      return [...sup, ...to]
    })

  endpoint = (tenant: string) =>
    this.one<string>(
      `endpoint:${tenant}`,
      `select id::text from core.webhook_endpoints where tenant_id = $1 and kind = 'http' order by created_at limit 1`,
      [tenant],
    )

  /** A pending or failed delivery of the tenant, as the delivery worker loads it. */
  delivery = (tenant: string) =>
    this.once(`delivery:${tenant}`, async () => {
      const [r] = await this
        .sql`select id::text, endpoint_id::text e, attempts from core.webhook_deliveries where tenant_id = ${tenant} order by status <> 'pending', created_at desc limit 1`
      return r
        ? {
            deliveryId: String(r.id),
            endpointId: String(r.e),
            tenantId: tenant,
            attempt: Number(r.attempts),
          }
        : { deliveryId: MISSING_UUID, endpointId: MISSING_UUID, tenantId: tenant }
    })

  apiKeyId = (tenant: string) =>
    this.one<string>(
      `keyId:${tenant}`,
      `select id::text from core.api_keys where tenant_id = $1 order by created_at limit 1`,
      [tenant],
    )

  sessionOf = (tenant: string) =>
    this.once(`session:${tenant}`, async () => {
      const [r] = await this
        .sql`select session_id, clerk_user_id from identity.sso_sessions where tenant_id = ${tenant} limit 1`
      const p = await this.principal(tenant)
      return {
        sessionId: String(r?.session_id ?? "sess_missing"),
        userId: String(r?.clerk_user_id ?? p.userId),
      }
    })

  ssoTenant = () =>
    this.one<string>(
      "ssoTenant",
      `select tenant_id::text from authd.required_domains group by 1 order by count(*) desc, 1 limit 1`,
    )

  hostedDomain = (tenant: string) =>
    this.one<string>(
      `hosted:${tenant}`,
      `select lower(name) from core.domains where tenant_id = $1 and hosts_mailboxes and status = 'verified' order by name limit 1`,
      [tenant],
    )
}
