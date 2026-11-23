/**
 * The "mail" half of the seed: the tables that grow with traffic. Rows are
 * generated day by day, oldest first, and in time order within a day, so the
 * physical order of each table follows `created_at` the way inserts in
 * production make it (that correlation is what the planner's index costs read).
 *
 * The shape over time: growth toward the present (the last month has about
 * three times the first), a daily cycle, quieter weekends, and campaign bursts
 * where one large workspace sends tens of thousands of messages in an hour.
 */
import type { Sql } from "postgres"
import { bulkRows, BulkWriter } from "./bulk.js"
import type { Profile } from "./profiles.js"
import { apportion, Discrete, Rng } from "./rng.js"
import {
  caseVariant,
  COUNTRIES,
  ipv4,
  localPart,
  personName,
  subject,
  USER_AGENTS,
} from "./values.js"
import type { Tenant, World } from "./seed-world.js"

const DAY = 86_400_000
const HOUR = 3_600_000
const INBOXES = [
  "gmail.com",
  "outlook.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "web.de",
  "mail.ru",
  "qq.com",
] as const
const HOURLY = [2, 1, 1, 1, 1, 2, 3, 5, 7, 8, 8, 8, 7, 7, 8, 8, 7, 6, 5, 4, 4, 3, 3, 2]

/** Creates the monthly partitions the history needs, with the DDL `ensure_message_partitions` uses. */
export async function ensurePastPartitions(sql: Sql, from: Date): Promise<void> {
  const ddl = await sql<
    { prosrc: string }[]
  >`select prosrc from pg_proc where proname = 'ensure_message_partitions'`
  if (!ddl[0]?.prosrc.includes("REVOKE ALL ON core.%I FROM i10_api")) {
    throw new Error(
      "ensure_message_partitions changed; update seed-mail.ts to match it",
    )
  }
  const m = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1))
  for (; ; m.setUTCMonth(m.getUTCMonth() + 1)) {
    const next = new Date(m)
    next.setUTCMonth(next.getUTCMonth() + 1)
    const suffix = `${m.getUTCFullYear()}_${String(m.getUTCMonth() + 1).padStart(2, "0")}`
    let any = false
    for (const tbl of ["messages", "message_bodies", "message_events"]) {
      const part = `${tbl}_${suffix}`
      const [exists] = await sql<
        { r: string | null }[]
      >`select to_regclass(${"core." + part})::text as r`
      if (exists?.r) continue
      any = true
      await sql.unsafe(
        `create table core.${part} partition of core.${tbl} for values from ('${m.toISOString()}') to ('${next.toISOString()}')`,
      )
      await sql.unsafe(`alter table core.${part} enable row level security`)
      await sql.unsafe(
        `create policy tenant_isolation on core.${part} using (tenant_id = current_setting('app.tenant_id')::uuid) with check (tenant_id = current_setting('app.tenant_id')::uuid)`,
      )
      await sql.unsafe(`revoke all on core.${part} from i10_api`)
    }
    if (!any && next.getTime() > Date.now()) break
  }
}

interface DayPlan {
  start: number
  count: number
  burst: { tenant: Tenant; at: number; count: number; broadcastId: string } | null
}

export interface MailCounts {
  [table: string]: number
}

export async function seedMail(
  sql: Sql,
  p: Profile,
  seed: number,
  world: World,
  log: (m: string) => void,
): Promise<MailCounts> {
  const anchor = world.anchor.getTime()
  const first = anchor - p.days * DAY
  await ensurePastPartitions(sql, new Date(first))

  const r = new Rng(seed, 100)
  const senders = world.senders
  const huge = senders.find((t) => t.n === 0)
  const base = senders.map((t) => t.weight)
  const baseTotal = base.reduce((a, b) => a + b, 0)
  const weights = senders.map(
    (t, i) =>
      (base[i]! / baseTotal) * (1 - p.hugeShare) + (t === huge ? p.hugeShare : 0),
  )
  const pickSender = new Discrete(weights)

  // Days: growth toward now, quiet weekends; 8 campaign days for the biggest senders.
  const dayWeights = Array.from({ length: p.days }, (_, d) => {
    const dow = new Date(first + d * DAY).getUTCDay()
    return (1 + (2 * d) / p.days) * (dow === 0 || dow === 6 ? 0.6 : 1)
  })
  const burstTotal = Math.floor(p.messages * 0.06)
  const perDay = apportion(
    p.messages - burstTotal,
    dayWeights.map((w) => w / dayWeights.reduce((a, b) => a + b, 0)),
  )
  const days: DayPlan[] = perDay.map((count, d) => ({
    start: first + d * DAY,
    count,
    burst: null,
  }))
  // ⚠ EIGHT DISTINCT DAYS: a day holds one burst, so a repeated draw would drop a
  // whole campaign's allocation. Redrawing only on a clash keeps every seed whose
  // draws never clashed byte for byte as before.
  const burstDays = new Set<number>()
  for (let b = 0; b < 8; b++) {
    let d = r.int(0, p.days - 2)
    while (burstDays.has(d)) d = r.int(0, p.days - 2)
    burstDays.add(d)
    const tenant =
      b < 4 && huge ? huge : senders[r.int(0, Math.min(20, senders.length - 1))]!
    days[d]!.burst = {
      tenant,
      at: days[d]!.start + r.int(8, 18) * HOUR,
      count: Math.floor(burstTotal / 8),
      broadcastId: r.uuid7(new Date(days[d]!.start)),
    }
  }

  const keysByTenant = new Map<string, string[]>()
  for (const k of world.apiKeys)
    keysByTenant.set(k.tenantId, [...(keysByTenant.get(k.tenantId) ?? []), k.id])
  const endpointsByTenant = new Map<string, World["endpoints"]>()
  for (const e of world.endpoints)
    if (e.kind === "http")
      endpointsByTenant.set(e.tenantId, [
        ...(endpointsByTenant.get(e.tenantId) ?? []),
        e,
      ])
  const sequence = new Map<string, number>()
  const suppressed = new Map<string, Set<string>>()

  const open = (table: string, cols: string[]) =>
    new BulkWriter(sql, table, cols).open()
  const [messages, bodies, events, meters, requests, deliveries, idem, suppressions] =
    await Promise.all([
      open("core.messages", [
        "id",
        "created_at",
        "tenant_id",
        "domain_id",
        "api_key_id",
        "queue",
        "status",
        "from_address",
        "to_addresses",
        "cc_addresses",
        "bcc_addresses",
        "reply_to",
        "subject",
        "attempts",
        "claimed_by",
        "claimed_at",
        "scheduled_at",
        "sent_at",
        "ses_message_id",
        "last_error",
        "provider_message_id",
        "sent_route",
        "broadcast_id",
      ]),
      open("core.message_bodies", [
        "message_id",
        "created_at",
        "tenant_id",
        "text",
        "html",
        "headers",
        "tags",
        "compacted_at",
      ]),
      open("core.message_events", [
        "id",
        "occurred_at",
        "tenant_id",
        "message_id",
        "type",
        "source_event_id",
        "payload",
      ]),
      open("core.meter_events", [
        "tenant_id",
        "feature_id",
        "event_id",
        "shard",
        "value",
        "occurred_at",
        "recorded_at",
        "ingested_at",
      ]),
      open("core.api_requests", [
        "id",
        "tenant_id",
        "api_key_id",
        "method",
        "path",
        "status",
        "duration_ms",
        "error_name",
        "user_agent",
        "occurred_at",
        "client_ip",
        "country",
      ]),
      open("core.webhook_deliveries", [
        "id",
        "tenant_id",
        "endpoint_id",
        "event_type",
        "occurred_at",
        "message_id",
        "payload",
        "status",
        "attempts",
        "response_status",
        "last_error",
        "delivered_at",
        "created_at",
        "next_attempt_at",
        "retry_policy",
        "sequence",
        "first_failed_at",
        "lane",
        "payload_expunged_at",
      ]),
      open("core.idempotency_keys", [
        "tenant_id",
        "key",
        "request_hash",
        "created_at",
        "message_ids",
      ]),
      open("core.suppressions", [
        "tenant_id",
        "address",
        "reason",
        "message_id",
        "created_at",
      ]),
    ])

  const recipient = (n: number) => {
    const a = `${localPart(r, n)}@${r.pick(INBOXES)}`
    return r.chance(0.05) ? caseVariant(r, a) : a
  }

  const deliver = async (t: Tenant, messageId: string, type: string, at: number) => {
    const eps = endpointsByTenant.get(t.id)
    if (!eps) return
    for (const [i, e] of eps.slice(0, 2).entries()) {
      if (i === 1 && !r.chance(0.3)) continue
      const status =
        anchor - at < 10 * 60_000
          ? r.weighted([
              ["pending", 60],
              ["delivered", 40],
            ] as const)
          : r.weighted([
              ["delivered", 95],
              ["failed", 3],
              ["pending", 2],
            ] as const)
      const attempts =
        status === "delivered"
          ? r.chance(0.9)
            ? 1
            : r.int(2, 4)
          : status === "failed"
            ? r.int(5, 12)
            : r.int(0, 3)
      const seq = e.ordered ? (sequence.get(e.id) ?? 0) + 1 : null
      if (seq !== null) sequence.set(e.id, seq)
      const old = anchor - at > 30 * DAY
      await deliveries.row([
        r.uuid7(new Date(at)),
        t.id,
        e.id,
        `email.${type}`,
        new Date(at),
        messageId,
        old
          ? "{}"
          : JSON.stringify({ type: `email.${type}`, data: { email_id: messageId } }),
        status,
        attempts,
        status === "pending" && attempts === 0
          ? null
          : status === "failed"
            ? r.pick([500, 502, 404, 410])
            : 200,
        status === "failed" ? "upstream answered 502" : null,
        status === "delivered" ? new Date(at + r.int(50, 5000)) : null,
        new Date(at),
        status === "pending" ? new Date(at + r.int(1, 600) * 1000) : null,
        t.plan === "free" ? "free" : "pro",
        seq,
        status === "delivered" && attempts === 1 ? null : new Date(at + 1000),
        e.ordered ? "ordered" : "retry",
        old ? new Date(at + 30 * DAY) : null,
      ])
    }
  }

  let n = 0
  let idemSeen = 0
  for (const day of days) {
    const times: { at: number; tenant: Tenant; broadcastId: string | null }[] = []
    for (let i = 0; i < day.count; i++) {
      let hour = 0
      for (let x = r.next() * 107; hour < 23 && (x -= HOURLY[hour]!) > 0; hour++);
      times.push({
        at: day.start + hour * HOUR + Math.floor(r.next() * HOUR),
        tenant: senders[pickSender.draw(r)]!,
        broadcastId: null,
      })
    }
    if (day.burst) {
      for (let i = 0; i < day.burst.count; i++) {
        times.push({
          at: day.burst.at + Math.floor(r.next() * HOUR),
          tenant: day.burst.tenant,
          broadcastId: day.burst.broadcastId,
        })
      }
    }
    times.sort((a, b) => a.at - b.at)
    for (const { at, tenant: t, broadcastId } of times) {
      if (at > anchor) continue
      n++
      const created = new Date(at)
      const id = r.uuid7(created)
      const sending = t.domains.filter((d) => d.status === "verified" && d.sends)
      const domain = r.chance(0.7) ? sending[0]! : r.pick(sending)
      const keys = keysByTenant.get(t.id)
      const apiKey = !broadcastId && keys && r.chance(0.9) ? r.pick(keys) : null
      const age = anchor - at
      const status =
        age < 120_000
          ? r.weighted([
              ["queued", 60],
              ["sending", 30],
              ["sent", 10],
            ] as const)
          : r.weighted([
              ["sent", 955],
              ["failed", 30],
              ["canceled", 10],
              ["queued", age < DAY ? 5 : 0],
            ] as const)
      const scheduled =
        status === "queued" && age >= 120_000
          ? new Date(anchor + r.int(1, 72) * HOUR)
          : null
      const recipients = r.chance(0.85) ? 1 : r.chance(0.8) ? r.int(2, 5) : r.int(6, 50)
      const to = Array.from({ length: recipients }, () => recipient(n))
      const sent = status === "sent"
      const route = r.chance(0.8) ? "ses" : "direct"
      const from = r.chance(0.2)
        ? `"${personName(r).replace(/"/g, "")}" <noreply@${domain.name}>`
        : `${r.pick(["noreply", "hello", "billing", "team"])}@${domain.name}`
      await messages.row([
        id,
        created,
        t.id,
        r.chance(0.97) ? domain.id : null,
        apiKey,
        broadcastId || r.chance(0.15) ? "bulk" : "transactional",
        status,
        from,
        to,
        r.chance(0.03) ? [recipient(n)] : [],
        r.chance(0.01) ? [recipient(n)] : [],
        r.chance(0.1) ? [`reply@${domain.name}`] : [],
        subject(r),
        sent ? 1 : status === "failed" ? r.int(1, 5) : 0,
        status === "sending" ? "worker-1" : null,
        status === "sending" ? created : null,
        scheduled,
        sent ? new Date(at + r.int(200, 5000)) : null,
        sent && route === "ses" ? r.token(16) : null,
        status === "failed"
          ? r.pick([
              "554 rejected",
              "timeout",
              "MessageRejected: Email address is not verified.",
            ])
          : null,
        sent ? r.token(16) : null,
        sent ? route : null,
        broadcastId,
      ])
      await bodies.row([
        id,
        created,
        t.id,
        r.chance(0.9)
          ? `Hello ${personName(r)}, ${"text ".repeat(r.int(5, 60))}`
          : null,
        r.chance(0.3) ? `<p>${subject(r)}</p>` : null,
        r.chance(0.05) ? JSON.stringify({ "X-Campaign": "seed" }) : null,
        r.chance(0.2)
          ? JSON.stringify([
              { name: "category", value: r.pick(["welcome", "receipt", "digest"]) },
            ])
          : null,
        age > 30 * DAY ? new Date(at + 30 * DAY) : null,
      ])
      if (apiKey) {
        await requests.row([
          r.uuid4(),
          t.id,
          apiKey,
          "POST",
          "/emails",
          status === "failed" && r.chance(0.3) ? 422 : 200,
          r.int(8, 400),
          null,
          r.pick(USER_AGENTS),
          created,
          ipv4(r),
          r.pick(COUNTRIES),
        ])
        if (r.chance(0.3))
          await requests.row([
            r.uuid4(),
            t.id,
            apiKey,
            "GET",
            "/emails/:id",
            200,
            r.int(3, 80),
            null,
            r.pick(USER_AGENTS),
            new Date(at + 1000),
            ipv4(r),
            r.pick(COUNTRIES),
          ])
        if (age < 2 * DAY && r.chance(0.3)) {
          idemSeen++
          await idem.row([t.id, `idem-${r.token(8)}`, r.token(32), created, [id]])
        }
      }
      // Events: queued, then sent and delivered, now and then a bounce, a complaint, an open, a click.
      await events.row([r.uuid7(created), created, t.id, id, "queued", null, null])
      if (sent) {
        const sentAt = at + 1000
        await meters.row([
          t.id,
          "emails",
          id,
          0,
          recipients,
          created,
          created,
          age < 5 * 60_000 ? null : new Date(at + 60_000),
        ])
        await events.row([
          r.uuid7(new Date(sentAt)),
          new Date(sentAt),
          t.id,
          id,
          "sent",
          null,
          null,
        ])
        await deliver(t, id, "sent", sentAt)
        const outcome = r.weighted([
          ["delivered", 950],
          ["bounced", 25],
          ["complained", 2],
          ["none", 23],
        ] as const)
        const outAt = Math.min(anchor, sentAt + r.int(1, 30) * 1000)
        if (outcome !== "none") {
          await events.row([
            r.uuid7(new Date(outAt)),
            new Date(outAt),
            t.id,
            id,
            outcome,
            `ses-${r.token(10)}`,
            outcome === "bounced"
              ? JSON.stringify({ bounceType: r.pick(["Permanent", "Transient"]) })
              : null,
          ])
          await deliver(t, id, outcome, outAt)
          if (outcome !== "delivered") {
            const set = suppressed.get(t.id) ?? new Set<string>()
            suppressed.set(t.id, set)
            const address = to[0]!.toLowerCase()
            if (!set.has(address)) {
              set.add(address)
              await suppressions.row([
                t.id,
                address,
                outcome === "bounced" ? "hard_bounce" : "complaint",
                id,
                new Date(outAt),
              ])
            }
          }
        }
        if (r.chance(0.25)) {
          const openAt = Math.min(anchor, sentAt + r.int(60, 72 * 3600) * 1000)
          await events.row([
            r.uuid7(new Date(openAt)),
            new Date(openAt),
            t.id,
            id,
            "opened",
            `ses-${r.token(10)}`,
            null,
          ])
          if (r.chance(0.25))
            await events.row([
              r.uuid7(new Date(openAt + 5000)),
              new Date(Math.min(anchor, openAt + 5000)),
              t.id,
              id,
              "clicked",
              `ses-${r.token(10)}`,
              JSON.stringify({ link: "https://example.test/" }),
            ])
        }
      }
    }
  }

  // The rest of the suppression list: imports and unsubscribes, most of them in the huge workspace.
  let supCount = [...suppressed.values()].reduce((a, s) => a + s.size, 0)
  const live = world.tenants.filter((t) => t.status !== "deleted")
  for (let i = 0; supCount < p.suppressions; i++) {
    const t = huge && r.chance(0.5) ? huge : r.pick(live)
    const set = suppressed.get(t.id) ?? new Set<string>()
    suppressed.set(t.id, set)
    const address = `${localPart(r, i + 1_000_000)}@${r.pick(INBOXES)}`
    if (set.has(address)) continue
    set.add(address)
    supCount++
    await suppressions.row([
      t.id,
      address,
      r.pick(["manual", "unsubscribe"]),
      null,
      new Date(anchor - r.int(0, p.days) * DAY),
    ])
  }

  const counts: MailCounts = {}
  for (const w of [
    messages,
    bodies,
    events,
    meters,
    requests,
    deliveries,
    idem,
    suppressions,
  ]) {
    const rows = await w.close()
    counts[w.table] = rows
  }
  log(`messages ${n}, idempotency ${idemSeen}, suppressions ${supCount}`)

  // Attempts are a function of the deliveries (one row per attempt), so they are
  // made in SQL from the committed deliveries, where the foreign key can see its
  // parent rows. The id is v7-shaped (time first) from an md5, not `uuidv7()`,
  // whose random bits would make two seeds differ.
  const attempts = await sql`
    insert into core.webhook_attempts (id, tenant_id, delivery_id, endpoint_id, attempt, trigger, lane, url, request_headers,
                                       response_status, duration_ms, error_kind, error, created_at)
    select (lpad(to_hex((extract(epoch from d.created_at + make_interval(secs => a * 30)) * 1000)::bigint), 12, '0')
            || '7' || substr(md5(d.id::text || a), 1, 3) || '8' || substr(md5(d.id::text || a), 4, 15))::uuid,
           d.tenant_id, d.id, d.endpoint_id, a,
           case when a = 1 then 'scheduled' when a % 7 = 0 then 'manual' else 'scheduled' end::core.webhook_attempt_trigger,
           d.lane, coalesce(e.url, 'https://polling.invalid/'), '{}'::jsonb,
           case when a = d.attempts and d.status = 'delivered' then 200 else 502 end,
           (abs(hashtext(d.id::text || a)) % 2000) + 20,
           case when a = d.attempts and d.status = 'delivered' then null else 'status' end::core.webhook_attempt_error,
           case when a = d.attempts and d.status = 'delivered' then null else 'upstream answered 502' end,
           d.created_at + make_interval(secs => a * 30)
      from core.webhook_deliveries d
      join core.webhook_endpoints e on e.id = d.endpoint_id
      cross join lateral generate_series(1, d.attempts) a
  `
  counts["core.webhook_attempts"] = attempts.count
  await sql`update core.webhook_endpoints e set next_sequence = s.n + 1
              from (select endpoint_id, max(sequence) n from core.webhook_deliveries where sequence is not null group by 1) s
             where s.endpoint_id = e.id`

  Object.assign(counts, await seedAudience(sql, p, new Rng(seed, 200), world))
  return counts
}

/** Contacts, templates, sign-in history and mailbox jobs: per-workspace, not per-message. */
async function seedAudience(
  sql: Sql,
  p: Profile,
  r: Rng,
  world: World,
): Promise<MailCounts> {
  const anchor = world.anchor.getTime()
  const live = world.tenants.filter((t) => t.status !== "deleted")
  const out: MailCounts = {}
  const weights = live.map((t) => (t.n === 0 ? 0.3 : t.weight))
  const contactCounts = apportion(
    p.contacts,
    weights.map((w) => w / weights.reduce((a, b) => a + b, 0)),
    0,
  )
  out["core.contacts"] = await bulkRows(
    sql,
    "core.contacts",
    [
      "id",
      "tenant_id",
      "email",
      "first_name",
      "last_name",
      "unsubscribed",
      "unsubscribed_at",
      "properties",
      "created_at",
      "updated_at",
    ],
    async (w) => {
      let k = 0
      for (const [i, t] of live.entries()) {
        const seen = new Set<string>()
        for (let c = 0; c < contactCounts[i]!; c++) {
          let email = `${localPart(r, k++)}@${r.pick(INBOXES)}`
          // Imported lists keep the capitals people typed; `(tenant, email)` is unique only byte for byte.
          if (r.chance(0.1)) email = caseVariant(r, email)
          if (seen.has(email)) continue
          seen.add(email)
          const unsub = r.chance(0.05)
          const at = new Date(anchor - Math.floor(r.next() ** 0.7 * p.days * DAY))
          const name = personName(r).split(" ")
          await w.row([
            r.uuid4(),
            t.id,
            email,
            name[0] || null,
            name.slice(1).join(" ") || null,
            unsub,
            unsub ? at : null,
            r.chance(0.4)
              ? JSON.stringify({
                  plan: r.pick(["free", "pro"]),
                  signup: r.int(2019, 2026),
                })
              : null,
            at,
            at,
          ])
        }
      }
    },
  )

  const templateCounts = apportion(
    p.templates,
    weights.map((w) => (w / weights.reduce((a, b) => a + b, 0)) ** 0.5),
    0,
  )
  const versions: [string, string, number, string][] = []
  out["core.templates"] = await bulkRows(
    sql,
    "core.templates",
    [
      "id",
      "tenant_id",
      "name",
      "subject",
      "html",
      "kind",
      "source",
      "created_at",
      "updated_at",
      "removed_at",
    ],
    async (w) => {
      for (const [i, t] of live.entries()) {
        for (let c = 0; c < templateCounts[i]!; c++) {
          const id = r.uuid4()
          const at = new Date(anchor - r.int(0, p.days) * DAY)
          for (let v = 1, nv = r.int(1, 4); v <= nv; v++)
            versions.push([id, t.id, v, at.toISOString()])
          await w.row([
            id,
            t.id,
            `${r.pick(["welcome", "receipt", "reset", "digest", "invite"])}-${c}`,
            subject(r),
            "<p>{{name}}</p>",
            r.weighted([
              ["html", 60],
              ["tsx", 20],
              ["visual", 20],
            ] as const),
            r.weighted([
              ["managed", 80],
              ["upload", 15],
              ["github", 5],
            ] as const),
            at,
            at,
            r.chance(0.05) ? new Date(anchor) : null,
          ])
        }
      }
    },
  )
  out["core.template_versions"] = await bulkRows(
    sql,
    "core.template_versions",
    [
      "id",
      "tenant_id",
      "template_id",
      "number",
      "kind",
      "subject",
      "html",
      "nonce",
      "variables",
      "created_at",
    ],
    async (w) => {
      for (const [tid, tenant, number, at] of versions)
        await w.row([
          r.uuid4(),
          tenant,
          tid,
          number,
          "html",
          "Hello",
          "<p>{{name}}</p>",
          r.token(12),
          "{}",
          at,
        ])
    },
  )
  await sql`update core.templates t set live_version_id = v.id
              from (select distinct on (template_id) template_id, id from core.template_versions order by template_id, number desc) v
             where v.template_id = t.id and t.removed_at is null`

  const people = live.flatMap((t) =>
    t.members.slice(0, 50).map((u) => [u, t.id] as const),
  )
  out["core.identity_events"] = await bulkRows(
    sql,
    "core.identity_events",
    [
      "id",
      "clerk_user_id",
      "tenant_id",
      "kind",
      "session_id",
      "ip",
      "subnet",
      "country",
      "asn",
      "user_agent",
      "device_id",
      "occurred_at",
    ],
    async (w) => {
      const times = Array.from(
        { length: p.identityEvents },
        () => anchor - Math.floor(r.next() * p.days * DAY),
      ).sort((a, b) => a - b)
      for (const at of times) {
        const [u, t] = r.pick(people)
        const ip = ipv4(r)
        await w.row([
          r.uuid7(new Date(at)),
          u,
          t,
          r.weighted([
            ["sign_in", 70],
            ["session_created", 20],
            ["sign_up", 5],
            ["password_changed", 5],
          ] as const),
          r.chance(0.8) ? `sess_${r.token(10)}` : null,
          ip,
          ip.split(".").slice(0, 3).join(".") + ".0/24",
          r.pick(COUNTRIES),
          r.chance(0.8) ? r.int(1000, 65000) : null,
          r.pick(USER_AGENTS),
          r.chance(0.7) ? `dev_${r.token(6)}` : null,
          new Date(at),
        ])
      }
    },
  )

  const mailboxes = live.flatMap((t) =>
    t.accounts.slice(0, 200).map((a) => [t.id, a] as const),
  )
  out["core.mailbox_auth_failures"] =
    mailboxes.length === 0
      ? 0
      : await bulkRows(
          sql,
          "core.mailbox_auth_failures",
          [
            "id",
            "tenant_id",
            "clerk_user_id",
            "account",
            "ip",
            "subnet",
            "listener",
            "occurred_at",
          ],
          async (w) => {
            for (let i = 0; i < p.mailboxAuthFailures; i++) {
              const at = new Date(anchor - Math.floor(r.next() * 30 * DAY))
              const [t, a] = r.pick(mailboxes)
              const ip = ipv4(r)
              await w.row([
                r.uuid7(at),
                t,
                a.clerkUserId,
                a.email,
                ip,
                ip.split(".").slice(0, 3).join(".") + ".0/24",
                r.pick(["imap", "smtp", "pop3"]),
                at,
              ])
            }
          },
        )

  out["core.mailbox_jobs"] =
    mailboxes.length === 0
      ? 0
      : await bulkRows(
          sql,
          "core.mailbox_jobs",
          [
            "id",
            "tenant_id",
            "mailbox_address",
            "type",
            "status",
            "requested_by",
            "created_at",
            "updated_at",
            "completed_at",
            "expires_at",
          ],
          async (w) => {
            for (let i = 0; i < Math.ceil(p.accounts / 15); i++) {
              const at = new Date(anchor - r.int(0, p.days) * DAY)
              const [t, a] = r.pick(mailboxes)
              const status = r.weighted([
                ["done", 85],
                ["failed", 5],
                ["pending", 5],
                ["running", 5],
              ] as const)
              await w.row([
                r.uuid7(at),
                t,
                a.email,
                r.pick(["export", "import"]),
                status,
                a.clerkUserId,
                at,
                at,
                status === "done" ? new Date(at.getTime() + HOUR) : null,
                status === "done" ? new Date(at.getTime() + 7 * DAY) : null,
              ])
            }
          },
        )
  return out
}
