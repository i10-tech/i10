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
 * ⚠ EVERY WRITE GOES THROUGH THE SAME DOOR THE SCORE USES and needs `--by` and
 * `--reason`, so what staff do here is audited exactly like what the score
 * does. It connects as `i10_api`, like everything else - no bypass role.
 *
 * ⚠ A RELEASE IS ALSO A LABEL. `false_positive` teaches the model the
 * workspace was legitimate; `upheld` that it was abuse. The features are
 * frozen as they are now, which is what the score saw.
 */
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
      }
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
      await risk.labels.add({
        tenantId: id,
        label,
        source: "staff",
        features: await frozenFeatures(id),
        setBy: need("by"),
        ...(flags.get("note") ? { note: flags.get("note")! } : {}),
      })
      console.log("labelled")
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
        "commands: explain, score, hold, release, pin, tier, label, linked, train - see the header of src/risk-admin.ts",
      )
  }
} finally {
  await cache.quit().catch(() => {})
  await pg.end({ timeout: 5 })
}
