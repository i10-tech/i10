/*
 * Fills `authd.user_emails` from Clerk for the users who existed before it
 * (#526). Run once per instance, after the deploy that brings the table. The
 * Clerk webhooks keep it current from then on.
 *
 *   bun run --filter @i10/api user-emails --instance dev            (dry run)
 *   bun run --filter @i10/api user-emails --instance dev --apply
 *
 * For every Clerk user, their verified sign-in emails are written exactly as
 * the `user.created`/`user.updated` webhook writes them (`projectUserEmails`).
 * A user whose row is newer than Clerk's `updated_at` is left alone, so it is
 * safe to re-run and safe to run while webhooks arrive.
 *
 * Clerk pages by offset, so a user deleted in Clerk during the run can shift a
 * later user past a page edge; re-running is safe and idempotent, so run it
 * twice.
 *
 * ⚠ DRY RUN UNLESS `--apply`. The dry run reads Clerk and prints what it would
 * write; nothing else.
 *
 * ⚠ `--instance` MUST MATCH THE KEY, as in workspace-roles.ts: `sk_test_` is
 * dev and `sk_live_` production, and a mismatch refuses to run.
 *
 * ⚠ `DATABASE_URL` IS THE APPLICATION'S ROLE (`i10_api`), the role the webhook
 * projection writes as.
 */
import { createClerkClient } from "@clerk/backend"
import { createDb } from "../src/db/client.js"
import { instanceOfKey } from "../src/console/roles-backfill.js"
import { verifiedEmailsOf, type ClerkUser } from "../src/projection/clerk-user.js"
import { projectUserEmails } from "../src/projection/writer.js"

const args = process.argv.slice(2)
const apply = args.includes("--apply")
const at = args.indexOf("--instance")
const instance = at >= 0 ? args[at + 1] : undefined

const key = process.env.CLERK_SECRET_KEY ?? ""
const url = process.env.DATABASE_URL

if (instance !== "dev" && instance !== "prod") {
  console.error("usage: user-emails --instance dev|prod [--apply]")
  process.exit(1)
}
if (!key) {
  console.error("CLERK_SECRET_KEY is required")
  process.exit(1)
}
const keyInstance = instanceOfKey(key)
if (keyInstance !== instance) {
  console.error(
    `--instance ${instance} does not match CLERK_SECRET_KEY, which is ${
      keyInstance ?? "neither sk_test_ nor sk_live_"
    }. Refusing to run.`,
  )
  process.exit(1)
}
if (!url) {
  console.error("DATABASE_URL is required (the i10_api role)")
  process.exit(1)
}

const clerk = createClerkClient({ secretKey: key })
const { sql, db } = createDb(url)

const PAGE = 100

console.log(`${apply ? "APPLYING" : "DRY RUN"} on the ${instance} Clerk instance.`)

let users = 0
let emails = 0
let failed = 0
for (let offset = 0; ; offset += PAGE) {
  const { data, totalCount } = await clerk.users.getUserList({
    limit: PAGE,
    offset,
    orderBy: "+created_at",
  })
  for (const u of data) {
    // `raw` is the same JSON a webhook carries, which is what the projection reads.
    const user = u.raw as ClerkUser | null
    if (!user) {
      failed += 1
      console.error(`  x ${u.id}: Clerk returned no raw JSON`)
      continue
    }
    const verified = verifiedEmailsOf(user)
    users += 1
    emails += verified.length
    console.log(`  ${user.id}: ${verified.join(", ") || "(no verified email)"}`)
    if (!apply) continue
    try {
      await projectUserEmails(db, user)
    } catch (error) {
      failed += 1
      console.error(`  x ${user.id}: ${String(error)}`)
    }
  }
  if (data.length < PAGE || offset + data.length >= totalCount) break
}

console.log(
  `${apply ? "wrote" : "would write"} ${emails} emails for ${users} users` +
    (failed ? `, ${failed} failed (re-run to retry)` : ""),
)
await sql.end()
process.exit(failed ? 1 : 0)
