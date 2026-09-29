/**
 * The staff side of the risk engine (#170), until the admin app (#217) exists.
 *
 *   bun run risk-admin explain  <tenant>
 *   bun run risk-admin score    <tenant>
 *   bun run risk-admin hold     <tenant> --by <you> --reason "<why>" [--scope all]
 *   bun run risk-admin release  <tenant> --by <you> --reason "<why>" --outcome false_positive|upheld [--pause-days 14]
 *   bun run risk-admin pin      <tenant> --by <you> --reason "<why>" [--days 30]
 *   bun run risk-admin tier     <tenant> strict|normal --by <you> --reason "<why>"
 *   bun run risk-admin label    <tenant> abuse|legit --by <you> [--note "<text>"]
 *   bun run risk-admin linked   <clerk user id>
 *   bun run risk-admin train
 *
 * Trusted content (#222):
 *
 *   bun run risk-admin boilerplate list
 *   bun run risk-admin boilerplate history
 *   bun run risk-admin boilerplate add --name <clerk/reset-password> --html <file> [--text <file>]
 *                                      [--subject "<subject>"] [--holes name=max,...] --by <you> --reason "<why>"
 *   bun run risk-admin boilerplate remove <id> --by <you> --reason "<why>"
 *   bun run risk-admin templates pending
 *   bun run risk-admin templates show    <id>
 *   bun run risk-admin templates approve <id> --by <you> [--reason "<note for the workspace>"]
 *   bun run risk-admin templates reject  <id> --by <you> --reason "<note for the workspace>"
 *   bun run risk-admin templates revoke  <id> --by <you> --reason "<note for the workspace>"
 *
 * ⚠ A DECISION'S REASON IS SENT TO THE WORKSPACE. Write it for them.
 *
 * ⚠ AN ABUSE VERDICT REVOKES EVERY APPROVAL. `label <tenant> abuse` and
 * `release --outcome upheld` take away the workspace's approved templates in
 * the same command (and the hourly run would, from the label, anyway).
 *
 * ⚠ EVERY WRITE GOES THROUGH THE SAME DOOR THE SCORE USES and needs `--by` and
 * `--reason`, so what staff do here is audited exactly like what the score
 * does. It connects as `i10_api`, like everything else - no bypass role.
 *
 * ⚠ A RELEASE IS ALSO A LABEL. `false_positive` teaches the model the
 * workspace was legitimate; `upheld` that it was abuse. The features are
 * frozen as they are now, which is what the score saw.
 */
import { readFile } from "node:fs/promises"
import { createClerkClient } from "@clerk/backend"
import { sql } from "drizzle-orm"
import { assertRlsSubject, createDb } from "./db/client.js"
import { loadEnv } from "./env.js"
import { createCacheClient } from "./cache/redis.js"
import { evaluate } from "./risk/engine.js"
import { loadFacts } from "./risk/facts.js"
import { explainPrediction, features, predict } from "./risk/model.js"
import { RULES } from "./risk/rules.js"
import { scoreTenant } from "./risk/runner.js"
import { CATEGORY_TEXT, type Category } from "./risk/types.js"
import { riskSystem, systemTenantIds } from "./risk/wire.js"
import { systemSenderFor } from "./auth-email/system.js"
import { createQueueClient } from "./cache/redis.js"
import { postgresMetering } from "./metering/service.js"
import { createSendQueue } from "./queue/send-queue.js"
import { resilient } from "./send/metering.js"
import { riskNotices, type TemplateDecisionNotice } from "./risk/notice.js"
import { describe as describeSkeleton, parseSubmission } from "./content/trust.js"
import { embedderFor } from "./content/embed.js"
import { htmlToText } from "./risk/fingerprint.js"
import type { TrustedTemplate } from "./risk/trusted.js"

const [command, ...rest] = process.argv.slice(2)
const flags = new Map<string, string>()
const positional: string[] = []
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!
  if (a.startsWith("--")) flags.set(a.slice(2), rest[++i] ?? "")
  else positional.push(a)
}
const need = (name: string) => {
  const v = flags.get(name)?.trim()
  if (!v) fail(`--${name} is required`)
  return v!
}
function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

const env = loadEnv()
const { sql: pg, db } = createDb(env.DATABASE_URL)
await assertRlsSubject(pg)
const cache = createCacheClient(env.REDIS_URL)
cache.on("error", () => {})
const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY })
const risk = riskSystem({
  db,
  env,
  clerk,
  redis: cache,
  exempt: await systemTenantIds(db, env.AUTH_EMAIL_TENANT_SLUG),
  log: { warn: (o, m) => console.warn(m, o), error: (o, m) => console.error(m, o) },
})
const tenant = () => positional[0] ?? fail("a workspace id is required")
const quiet = { warn: () => {}, error: () => {}, info: () => {} }

/*
 * ⚠ THE SAME SYSTEM SENDER THE HOURLY JOB USES, built only for the commands
 * that email a workspace, so a `boilerplate list` never opens a queue.
 */
let queueRedis: ReturnType<typeof createQueueClient> | null = null
async function notify(input: TemplateDecisionNotice) {
  const consoleUrl = env.CONSOLE_ORIGINS[0]
  if (!consoleUrl) {
    console.warn("CONSOLE_ORIGINS is empty; the workspace was not emailed")
    return
  }
  queueRedis ??= createQueueClient(env.REDIS_URL)
  queueRedis.on("error", () => {})
  const queue = (cls: "transactional" | "bulk") =>
    createSendQueue({
      redis: queueRedis!,
      class: cls,
      jobTimeoutMs: env.WORKER_JOB_TIMEOUT_MS,
      maxAttempts: env.WORKER_MAX_ATTEMPTS,
    })
  const sender = await systemSenderFor({
    sql: pg,
    db,
    queues: { transactional: queue("transactional"), bulk: queue("bulk") },
    metering: resilient(
      postgresMetering({
        db,
        featureId: env.METERING_FEATURE_ID,
        freePlanId: env.METERING_FREE_PLAN_ID,
        log: quiet as never,
      }),
      quiet as never,
    ),
    from: env.AUTH_EMAIL_FROM,
    tenantSlug: env.AUTH_EMAIL_TENANT_SLUG,
    log: quiet as never,
  })
  if (!sender) {
    console.warn("no system sender configured; the workspace was not emailed")
    return
  }
  await riskNotices({ db, clerk, sender, consoleUrl }).templateDecision(input)
  console.log("the workspace was emailed")
}

const decided = (t: TrustedTemplate, decision: TemplateDecisionNotice["decision"]) =>
  notify({
    tenantId: t.tenantId,
    templateId: t.id,
    template: t.name,
    decision,
    reason: t.decisionReason,
  }).catch((error: unknown) => console.error("could not email the workspace:", error))

/** Takes away every approval of a workspace staff just called abusive. */
async function revokeForAbuse(tenantId: string, by: string) {
  const revoked = await risk.trustedTemplates.revokeAll(
    tenantId,
    by,
    "The workspace was confirmed abusive by our team.",
  )
  for (const t of revoked) {
    console.log(`revoked the approval of template ${t.id} (${t.name})`)
    await decided(t, "revoked")
  }
}

async function templateById(id: string) {
  const rows = (await db.execute(
    sql`select core.trusted_template_tenant(${id}::uuid) as tenant_id`,
  )) as unknown as { tenant_id: string | null }[]
  const tenantId = rows[0]?.tenant_id
  if (!tenantId) fail(`no submitted template ${id}`)
  const t = await risk.trustedTemplates.get(tenantId, id)
  if (!t) fail(`no submitted template ${id}`)
  return t
}

function parseHoles(spec: string | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of (spec ?? "").split(",").filter(Boolean)) {
    const [name, max] = part.split("=")
    if (!name || !max || !Number.isInteger(Number(max)))
      fail(`bad --holes entry ${part}`)
    out[name.trim()] = Number(max)
  }
  return out
}

async function frozenFeatures(tenantId: string) {
  const facts = await loadFacts(tenantId, {
    db,
    freePlanId: env.METERING_FREE_PLAN_ID,
    ownerInfo: risk.deps.ownerInfo,
  })
  return features(facts) as unknown as Record<string, number>
}

try {
  switch (command) {
    case "explain": {
      const id = tenant()
      const facts = await loadFacts(id, {
        db,
        freePlanId: env.METERING_FREE_PLAN_ID,
        ownerInfo: risk.deps.ownerInfo,
      })
      const model = await risk.labels.model(true)
      const feats = features(facts)
      if (model)
        facts.model = {
          probability: predict(model.weights, feats),
          version: model.version,
        }
      const a = evaluate(facts)
      const [current, hold, history] = await Promise.all([
        risk.assessments.current(id),
        risk.holds.current(id),
        risk.assessments.history(id, 10),
      ])
      console.log(
        `\nworkspace ${id} (${facts.plan}), created ${facts.createdAt.toISOString()}`,
      )
      console.log(`now: score ${a.score}, band ${a.band}, ruleset v${a.rulesetVersion}`)
      if (current)
        console.log(
          `stored: score ${current.score}, band ${current.band} since ${current.bandSince.toISOString()}`,
        )
      if (current?.autoActionsPausedUntil)
        console.log(
          `automatic actions paused until ${current.autoActionsPausedUntil.toISOString()}`,
        )
      console.log(`tier: ${facts.history.tier} (${facts.history.tierSource})`)
      console.log(
        hold
          ? `HELD since ${hold.heldAt.toISOString()} by ${hold.setBy}: ${hold.reason} (review due ${hold.reviewDueAt.toISOString()})`
          : "not held",
      )
      console.log("\ncontributions:")
      for (const c of a.contributions) {
        const r = RULES.find((x) => x.id === c.rule)
        console.log(
          `  ${String(c.points).padStart(4)}  ${c.rule.padEnd(28)} ${r?.summary ?? ""}`,
        )
        console.log(
          `        ${JSON.stringify(c.evidence)}${c.floor ? `  floor=${c.floor}` : ""}`,
        )
        // ⚠ WHAT A SIMILARITY FINDING WAS BASED ON (#222): counts and
        // distances, never who the neighbours are.
        if (c.detail) console.log(`        based on: ${JSON.stringify(c.detail)}`)
      }
      console.log(
        `\ntrusted content, last 7 days: ${facts.farm.trusted.template} approved-template, ${facts.farm.trusted.boilerplate} boilerplate`,
      )
      if (model && facts.model) {
        console.log(`\nmodel v${model.version}: ${facts.model.probability.toFixed(3)}`)
        for (const p of explainPrediction(model.weights, feats).slice(0, 6)) {
          console.log(`  ${p.pull >= 0 ? "+" : ""}${p.pull.toFixed(2)}  ${p.feature}`)
        }
      }
      console.log(
        `\nfarm peers: ${facts.farm.peers.length}, parents shared with: ${facts.parents.sharedWith}`,
      )
      console.log("\nhistory:")
      for (const e of history) {
        console.log(
          `  ${e.occurredAt.toISOString()}  ${e.fromBand ?? "-"} -> ${e.band} (${e.score}) [${e.trigger}] ${e.actions.join(" ")}`,
        )
      }
      break
    }
    case "score": {
      const model = await risk.labels.model(true)
      console.log(await scoreTenant(tenant(), "staff", { ...risk.deps, model }))
      break
    }
    case "hold": {
      const scope = flags.get("scope") === "all" ? "all" : "api"
      const category = (flags.get("category") ?? "sending_pattern") as Category
      if (!(category in CATEGORY_TEXT)) fail(`unknown category ${category}`)
      const r = await risk.holds.hold({
        tenantId: tenant(),
        source: "staff",
        setBy: need("by"),
        reason: need("reason"),
        category,
        scope,
      })
      console.log(r ? `held; ${r.canceled} queued message(s) canceled` : "already held")
      break
    }
    case "release": {
      const id = tenant()
      const outcome = need("outcome")
      if (outcome !== "false_positive" && outcome !== "upheld")
        fail("--outcome is false_positive or upheld")
      const by = need("by")
      const reason = need("reason")
      const feats = await frozenFeatures(id)
      const released = await risk.holds.release({
        tenantId: id,
        setBy: by,
        reason,
        outcome,
        pauseDays: Number(flags.get("pause-days") ?? 14),
      })
      if (!released) fail("not held")
      await risk.labels.add({
        tenantId: id,
        label: outcome === "false_positive" ? "legit" : "abuse",
        source: outcome === "false_positive" ? "hold_released" : "hold_upheld",
        features: feats,
        setBy: by,
        note: reason,
      })
      console.log(`released (${outcome}); labelled; automatic actions paused`)
      if (outcome === "upheld") await revokeForAbuse(id, by)
      break
    }
    case "pin": {
      const days = Number(flags.get("days") ?? 30)
      const now = new Date()
      const ok = await risk.assessments.pause(
        tenant(),
        new Date(now.getTime() + days * 86_400_000),
        now,
        {
          by: need("by"),
          reason: need("reason"),
        },
      )
      console.log(
        ok
          ? `automatic actions paused for ${days} days`
          : "no assessment yet; run score first",
      )
      break
    }
    case "tier": {
      const tier = positional[1]
      if (tier !== "strict" && tier !== "normal") fail("tier is strict or normal")
      const r = await risk.tiers.set({
        tenantId: tenant(),
        tier,
        source: "staff",
        setBy: need("by"),
        reason: need("reason"),
      })
      console.log(
        r.changed ? `moved ${r.from} -> ${tier}` : `already ${tier}; recorded as staff`,
      )
      break
    }
    case "label": {
      const id = tenant()
      const label = positional[1]
      if (label !== "abuse" && label !== "legit") fail("label is abuse or legit")
      const by = need("by")
      await risk.labels.add({
        tenantId: id,
        label,
        source: "staff",
        features: await frozenFeatures(id),
        setBy: by,
        ...(flags.get("note") ? { note: flags.get("note")! } : {}),
      })
      console.log("labelled")
      if (label === "abuse") await revokeForAbuse(id, by)
      break
    }
    case "boilerplate": {
      const sub = positional[0]
      if (sub === "list") {
        const rows = await risk.boilerplate.list()
        console.table(
          rows.map((b) => ({
            id: b.id,
            name: b.name,
            holes: b.holes,
            fixed: b.staticBytes,
            embedded: b.model ?? "-",
            by: b.addedBy,
            at: b.addedAt.toISOString().slice(0, 10),
            reason: b.reason,
          })),
        )
      } else if (sub === "history") {
        console.table(await risk.boilerplate.history(Number(flags.get("limit") ?? 50)))
      } else if (sub === "add") {
        const name = need("name")
        const html = flags.get("html") ? await readFile(need("html"), "utf8") : null
        const text = flags.get("text") ? await readFile(need("text"), "utf8") : null
        const skeleton = parseSubmission({
          html,
          text,
          holes: parseHoles(flags.get("holes")),
        })
        if ("error" in skeleton) fail(skeleton.error)
        const by = need("by")
        const reason = need("reason")
        // ⚠ THE EMBEDDING IS FOR STAFF'S EVIDENCE ONLY ("reads like this entry
        // but did not fit it"); matching is always the exact skeleton.
        const embedder = await embedderFor(env.RISK_EMBEDDER, quiet as never)
        const shown = describeSkeleton(skeleton.template, skeleton.holes)
        const [embedding] = await embedder.embed([
          `${flags.get("subject") ?? ""}\n${shown.text ?? (shown.html ? htmlToText(shown.html) : "")}`
            .replace(/\s+/g, " ")
            .slice(0, 2_000),
        ])
        const id = await risk.boilerplate.add({
          name,
          skeleton,
          model: embedder.model,
          embedding: embedding ?? null,
          reason,
          by,
        })
        console.log(
          `added ${id} (${skeleton.holes.length} holes, ${skeleton.staticBytes} fixed bytes, ${embedder.model})`,
        )
      } else if (sub === "remove") {
        const id = positional[1] ?? fail("an entry id is required")
        const ok = await risk.boilerplate.remove(id, need("reason"), need("by"))
        console.log(ok ? "removed; its marks were cleared" : "no such entry")
      } else {
        fail("boilerplate list | history | add | remove")
      }
      break
    }
    case "templates": {
      const sub = positional[0]
      if (sub === "pending") {
        console.table(
          (await db.execute(
            sql`select * from core.trusted_templates_pending()`,
          )) as unknown as unknown[],
        )
        break
      }
      const t = await templateById(positional[1] ?? fail("a template id is required"))
      if (sub === "show") {
        console.log(`\n${t.name} (${t.status}) in workspace ${t.tenantId}`)
        console.log(`submitted ${t.submittedAt.toISOString()} by ${t.submittedBy}`)
        if (t.decidedAt)
          console.log(
            `decided ${t.decidedAt.toISOString()} by ${t.decidedBy}: ${t.decisionReason ?? ""}`,
          )
        console.log(`matched ${t.matched} message(s)`)
        console.log("\nholes:")
        for (const h of t.holes) console.log(`  {{${h.name}}}  max ${h.max}`)
        console.log("\nlinks in the fixed part, with Web Risk:")
        for (const host of t.staticHosts)
          console.log(`  ${host}  ${(await risk.webRisk.lookup(host)) ?? "unknown"}`)
        const shown = describeSkeleton({ segments: t.segments }, t.holes)
        if (shown.html !== null) console.log(`\n--- html ---\n${shown.html}`)
        if (shown.text !== null) console.log(`\n--- text ---\n${shown.text}`)
        console.log("\nhistory:")
        for (const e of await risk.trustedTemplates.events(t.tenantId, t.id))
          console.log(
            `  ${e.occurredAt.toISOString()}  ${e.action} by ${e.setBy}${e.reason ? `: ${e.reason}` : ""}`,
          )
      } else if (sub === "approve") {
        // ⚠ EVERY LINK IN THE FIXED PART MUST BE CHECKED CLEAN FIRST. Unknown
        // (budget spent, Web Risk down) is not clean: try again later.
        for (const host of t.staticHosts) {
          const v = await risk.webRisk.lookup(host)
          if (v !== "clean")
            fail(`Web Risk says ${v ?? "nothing yet"} for ${host}; not approved`)
        }
        const r = await risk.trustedTemplates.decide(
          t.tenantId,
          t.id,
          "approve",
          need("by"),
          flags.get("reason")?.trim() || "",
        )
        if (!r) fail(`not pending (it is ${t.status})`)
        console.log("approved")
        await decided(r, "approved")
      } else if (sub === "reject") {
        const r = await risk.trustedTemplates.decide(
          t.tenantId,
          t.id,
          "reject",
          need("by"),
          need("reason"),
        )
        if (!r) fail(`not pending (it is ${t.status})`)
        console.log("rejected")
        await decided(r, "rejected")
      } else if (sub === "revoke") {
        const r = await risk.trustedTemplates.revoke(
          t.tenantId,
          t.id,
          need("by"),
          need("reason"),
        )
        if (!r) fail(`not approved (it is ${t.status})`)
        console.log("revoked; its marks were cleared")
        await decided(r, "revoked")
      } else {
        fail("templates pending | show | approve | reject | revoke")
      }
      break
    }
    case "linked": {
      const user = positional[0] ?? fail("a Clerk user id is required")
      const rows = await db.execute(sql`
        select * from core.identity_linked_users(${user}, now() - interval '90 days')
      `)
      console.table(rows)
      break
    }
    case "train": {
      const r = await risk.labels.retrain()
      console.log(
        `model v${r.version} ${r.active ? "ACTIVE" : "inactive"}`,
        r.evaluation,
      )
      break
    }
    default:
      fail(
        "commands: explain, score, hold, release, pin, tier, label, linked, train, boilerplate, templates - see the header of src/risk-admin.ts",
      )
  }
} finally {
  await cache.quit().catch(() => {})
  await (queueRedis as ReturnType<typeof createQueueClient> | null)
    ?.quit()
    .catch(() => {})
  await pg.end({ timeout: 5 })
}
