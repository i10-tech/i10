/*
 * Moves one Clerk instance's workspace roles into our table, then takes
 * Clerk's away (#335). Run once per instance, after the deploy that brings
 * `core.workspace_roles`, with the instance's `domains_default_role` switched
 * to `org:member`.
 *
 *   bun run --filter @i10/api workspace-roles --instance dev            (dry run)
 *   bun run --filter @i10/api workspace-roles --instance dev --apply
 *
 * For every organization: (a) a row in `core.workspace_roles` for each member
 * we hold none for - the creator owner, Clerk's `org:admin` admin, everybody
 * else member - and then (b) every Clerk membership that is not `org:member`
 * set to `org:member`. A row we already hold is never overwritten. The plan
 * itself is console/roles-backfill.ts.
 *
 * ⚠ DRY RUN UNLESS `--apply`. The dry run reads Clerk and our database and
 * prints exactly what it would write; nothing else.
 *
 * ⚠ `--instance` MUST MATCH THE KEY. `CLERK_SECRET_KEY` starting `sk_test_` is
 * the dev instance and `sk_live_` production; the script refuses to run when
 * the flag and the key disagree, so a production key in the wrong shell cannot
 * be pointed at by habit.
 *
 * ⚠ `DATABASE_URL` IS THE APPLICATION'S ROLE (`i10_api`), NOT THE OWNER. Every
 * write goes through `withTenant` and the table's policy, exactly as the API's
 * do, and the tenant is found through the same definer the webhooks use.
 *
 * ⚠ AND IT DOES NOT TOUCH CLERK'S INSTANCE SETTINGS. `domains_default_role`
 * is switched to `org:member` by hand (dashboard, or
 * `PATCH /instance/organization_settings`).
 *
 * ⚠ `creator_role` CANNOT BE SWITCHED, AND NEED NOT BE. Clerk refuses a
 * creator role without `sys_memberships:manage`, `sys_profile:delete` and
 * `sys_memberships:read` (`organization_missing_creator_role_permissions`),
 * and provisioning needs Clerk's `created_by`, so every creator starts as a
 * Clerk admin. Our API creates workspaces and demotes the creator at once,
 * and the membership webhooks demote any other (see `createWorkspace` and
 * `fixClerkRole` in console/roles.ts). Re-run this once every pending
 * invitation it warns about has gone.
 */
import { createClerkClient, type ClerkClient } from "@clerk/backend"
import { createDb } from "../src/db/client.js"
import { memberStore } from "../src/console/members-db.js"
import { roleStore } from "../src/console/roles-db.js"
import { CLERK_ROLE } from "../src/console/roles.js"
import {
  backfillRows,
  instanceOfKey,
  planOrg,
  type OrgPlan,
  type OrgSnapshot,
} from "../src/console/roles-backfill.js"

const args = process.argv.slice(2)
const apply = args.includes("--apply")
const at = args.indexOf("--instance")
const instance = at >= 0 ? args[at + 1] : undefined

const key = process.env.CLERK_SECRET_KEY ?? ""
const url = process.env.DATABASE_URL

if (instance !== "dev" && instance !== "prod") {
  console.error("usage: workspace-roles --instance dev|prod [--apply]")
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
const members = memberStore(db)
const roles = roleStore(db)

const PAGE = 100

async function everyOrganization(c: ClerkClient) {
  const out = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, totalCount } = await c.organizations.getOrganizationList({
      limit: PAGE,
      offset,
    })
    out.push(...data)
    if (data.length < PAGE || out.length >= totalCount) return out
  }
}

async function everyMembership(c: ClerkClient, organizationId: string) {
  const out = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, totalCount } = await c.organizations.getOrganizationMembershipList({
      organizationId,
      limit: PAGE,
      offset,
    })
    out.push(...data)
    if (data.length < PAGE || out.length >= totalCount) return out
  }
}

async function snapshot(orgId: string, name: string, createdBy: string | null) {
  const [memberships, invitations, tenantId] = await Promise.all([
    everyMembership(clerk, orgId),
    clerk.organizations.getOrganizationInvitationList({
      organizationId: orgId,
      status: ["pending"],
      limit: PAGE,
    }),
    members.tenantOf(orgId),
  ])
  const org: OrgSnapshot = {
    orgId,
    name,
    createdBy,
    tenantId,
    memberships: memberships.flatMap((m) =>
      m.publicUserData?.userId
        ? [
            {
              membershipId: m.id,
              userId: m.publicUserData.userId,
              role: m.role,
              identifier: m.publicUserData.identifier ?? m.publicUserData.userId,
            },
          ]
        : [],
    ),
    rows: tenantId ? await roles.list(tenantId) : [],
    pendingInvitations: invitations.data.map((i) => ({
      id: i.id,
      email: i.emailAddress,
      role: i.role,
    })),
  }
  return org
}

function print(plan: OrgPlan) {
  console.log(`\n${plan.name} (${plan.orgId}) tenant ${plan.tenantId ?? "-"}`)
  for (const b of plan.backfill)
    console.log(`  + ${b.role.padEnd(6)} ${b.identifier} (${b.userId})`)
  for (const k of plan.kept)
    console.log(`  = ${k.role.padEnd(6)} ${k.identifier} (${k.userId}) kept`)
  for (const m of plan.demote)
    console.log(
      `  v ${m.from} -> ${CLERK_ROLE} in Clerk: ${m.identifier} (${m.userId})`,
    )
  for (const w of plan.warnings) console.log(`  ! ${w}`)
}

console.log(
  `${apply ? "APPLYING" : "DRY RUN"} on the ${instance} Clerk instance. ` +
    "+ row to write, = row kept, v Clerk membership to demote, ! needs a person.",
)

let written = 0
let demoted = 0
let failed = 0
for (const org of await everyOrganization(clerk)) {
  const plan = planOrg(await snapshot(org.id, org.name, org.createdBy ?? null))
  print(plan)
  if (!apply) continue
  try {
    if (plan.tenantId && plan.backfill.length > 0)
      written += await roles.transact(plan.tenantId, (rows) =>
        backfillRows(rows, plan.backfill),
      )
    for (const m of plan.demote) {
      await clerk.organizations.updateOrganizationMembership({
        organizationId: plan.orgId,
        userId: m.userId,
        role: CLERK_ROLE,
      })
      demoted += 1
    }
  } catch (error) {
    // ⚠ ONE WORKSPACE'S FAILURE STOPS ITS DEMOTION, NOT THE RUN. Its rows (if
    // any were written) stand; re-running picks up where it left off.
    failed += 1
    console.error(`  x failed: ${String(error)}`)
  }
}

console.log(
  apply
    ? `\nDone: ${written} rows written, ${demoted} memberships demoted, ${failed} workspaces failed.`
    : "\nDry run: nothing was written. Re-run with --apply to write it.",
)
await sql.end({ timeout: 5 })
process.exit(failed > 0 ? 1 : 0)
