import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { withTenant, type Database } from "../src/db/client.js"
import { joinStore } from "../src/console/join.js"
import { memberStore } from "../src/console/members-db.js"
import { directoryStore } from "../src/identity/scim-store.js"
import { identityStore } from "../src/identity/store.js"
import { mailboxAliases } from "../src/mailboxes/aliases.js"
import { mailboxJobStore } from "../src/mailboxes/jobs.js"
import { directoryMail } from "../src/mailboxes/store.js"
import { applyClerkEvent } from "../src/projection/writer.js"
import { suppressionStore } from "../src/suppressions/store.js"
import { teamInboxStore } from "../src/team-inboxes/store.js"
import { recordMailboxUsageStatement } from "../src/mail/storage.js"
import { webhookEventOps } from "../src/webhooks/db.js"
import { accountEventOps } from "../src/webhooks/stalwart-account-db.js"

/**
 * Proves that every lowercase CHECK constraint refuses mixed-case writes at the
 * database layer, while the real store writers accept mixed-case inputs and
 * persist them lowercased.
 *
 *   LOWERCASE_TEST_DATABASE_URL=postgres://i10:i10@127.0.0.1:55541/i10 bun test test/lowercase-checks-db.test.ts
 */
// eslint-disable-next-line turbo/no-undeclared-env-vars -- a test-only switch, like the other *-db tests
const URL = process.env.LOWERCASE_TEST_DATABASE_URL
const API_URL = URL?.replace(/\/\/[^@]+@/, "//i10_api:i10_api@")
const suite = URL ? describe : describe.skip

const RUN = crypto.randomUUID().slice(0, 8)
const TENANT = crypto.randomUUID()
const CONN = crypto.randomUUID()
const DIR = crypto.randomUUID()
const DOMAIN_ID = crypto.randomUUID()
const USER = `user_lc_${RUN}`
const DOMAIN = `lc-${RUN}.example`

interface PgErrorLike {
  code?: unknown
  constraint_name?: unknown
  cause?: PgErrorLike
}

async function expectCheckViolation(
  run: () => Promise<unknown>,
  constraint: string,
): Promise<void> {
  let caught: unknown = null
  try {
    await run()
  } catch (err) {
    caught = err
  }
  expect(caught).not.toBeNull()
  const outer = caught as PgErrorLike
  const inner = outer.cause ?? outer
  expect(inner.code).toBe("23514")
  expect(inner.constraint_name).toBe(constraint)
}

suite("lowercase CHECK constraints", () => {
  let owner: ReturnType<typeof postgres>
  let apiClient: ReturnType<typeof postgres>
  let db: Database

  beforeAll(async () => {
    owner = postgres(URL!, { max: 2, onnotice: () => {} })
    apiClient = postgres(API_URL!, { max: 4, onnotice: () => {} })
    db = drizzle({ client: apiClient }) as unknown as Database

    await owner`
      insert into core.tenants (id, slug, name, owner_clerk_user_id, clerk_org_id)
      values (${TENANT}, ${`lc-${RUN}`}, 'Lowercase Test', ${USER}, ${`org_lc_${RUN}`})
    `
    await owner`
      insert into core.domains (id, tenant_id, name, status, hosts_mailboxes, verified_at, identity_registered_at)
      values (${DOMAIN_ID}, ${TENANT}, ${DOMAIN}, 'verified', true, now(), now())
    `
    await owner`
      insert into identity.connections (id, tenant_id, name, protocol)
      values (${CONN}, ${TENANT}, 'LC Conn', 'saml')
    `
    await owner`
      insert into identity.directories (id, tenant_id, name, provider, created_by)
      values (${DIR}, ${TENANT}, 'LC Dir', 'okta', ${USER})
    `
    await owner`
      insert into authd.accounts (clerk_user_id, email, active, tenant_id)
      values (${USER}, ${`owner@${DOMAIN}`}, true, ${TENANT})
    `
  })

  afterAll(async () => {
    if (owner) {
      await owner`delete from authd.groups where tenant_id = ${TENANT} or name like ${`lc-${RUN}%`} or name like ${`fwd-${USER}%`}`
      await owner`delete from authd.accounts where clerk_user_id like ${`user_lc_${RUN}%`}`
      await owner`delete from authd.webhook_events where event_id like ${`evt_lc_${RUN}%`}`
      await owner`delete from core.mailbox_jobs where tenant_id = ${TENANT}`
      await owner`delete from core.message_events where tenant_id = ${TENANT}`
      await owner`delete from core.tenants where id = ${TENANT}`
      // The tenant delete's trigger (retention_horizons_keep_deleted) leaves a
      // horizon row behind; remove it as retention-due-db.test.ts does.
      await owner`delete from core.retention_horizons where tenant_id = ${TENANT}`
      await owner.end()
    }
    if (apiClient) await apiClient.end()
  })

  it("refuses mixed-case writes on every constrained column", async () => {
    await expectCheckViolation(
      () =>
        owner`insert into core.domains (tenant_id, name, status)
              values (${TENANT}, ${`Mixed-${RUN}.Example`}, 'pending')`,
      "domains_name_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into core.suppressions (tenant_id, address, reason)
              values (${TENANT}, ${`Bob-${RUN}@Example.test`}, 'manual')`,
      "suppressions_address_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into authd.aliases (address, clerk_user_id, source)
              values (${`Sales@${DOMAIN}`}, ${USER}, 'console')`,
      "aliases_address_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into authd.accounts (clerk_user_id, email, active, tenant_id)
              values (${`${USER}_upper`}, ${`Upper@${DOMAIN}`}, true, ${TENANT})`,
      "accounts_email_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into authd.groups (name, email, tenant_id)
              values (${`lc-${RUN}-bad-group`}, ${`Support@${DOMAIN}`}, ${TENANT})`,
      "groups_email_lowercase",
    )
    // Nullable groups.email still permits NULL (delegate routes have no email).
    await owner`
      insert into authd.groups (name, email, tenant_id)
      values (${`lc-${RUN}-null-group`}, null, ${TENANT})
    `

    await expectCheckViolation(
      () =>
        owner`insert into core.join_domains (tenant_id, name, clerk_org_id, source)
              values (${TENANT}, ${`Join-${RUN}.Example`}, ${`org_lc_${RUN}`}, 'txt')`,
      "join_domains_name_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into authd.required_domains (domain, tenant_id, connection_id)
              values (${`Req-${RUN}.Example`}, ${TENANT}, ${CONN})`,
      "required_domains_domain_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into core.join_exclusions (tenant_id, email, kind)
              values (${TENANT}, ${`Blocked@${DOMAIN}`}, 'blocked')`,
      "join_exclusions_email_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into core.domain_transfers
              (tenant_id, domain_id, domain_name, recipient_email, offered_by, from_workspace, expires_at)
              values (${TENANT}, ${DOMAIN_ID}, ${DOMAIN}, ${`To@${DOMAIN}`}, ${USER}, 'LC', now() + interval '1 day')`,
      "domain_transfers_recipient_email_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into core.member_invitations
              (tenant_id, clerk_org_id, email, role, inviter_user_id, expires_at, zone)
              values (${TENANT}, ${`org_lc_${RUN}`}, ${`Invite@${DOMAIN}`}, 'member', ${USER}, now() + interval '1 day', 'UTC')`,
      "member_invitations_email_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into core.delegations (name, domain_id, tenant_id)
              values (${`Deleg-${RUN}.Example`}, ${DOMAIN_ID}, ${TENANT})`,
      "delegations_name_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into core.mailbox_usage (address, tenant_id, used_bytes)
              values (${`Usage@${DOMAIN}`}, ${TENANT}, 128)`,
      "mailbox_usage_address_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into core.mailbox_jobs (tenant_id, mailbox_address, type, requested_by)
              values (${TENANT}, ${`Job@${DOMAIN}`}, 'export', ${USER})`,
      "mailbox_jobs_mailbox_address_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into core.mailbox_auth_failures (tenant_id, clerk_user_id, account, occurred_at)
              values (${TENANT}, ${USER}, ${`Fail@${DOMAIN}`}, now())`,
      "mailbox_auth_failures_account_lowercase",
    )

    await expectCheckViolation(
      () =>
        owner`insert into identity.directory_users (tenant_id, directory_id, user_name, email)
              values (${TENANT}, ${DIR}, ${`MixedUser@${DOMAIN}`}, ${`MixedUser@${DOMAIN}`})`,
      "directory_users_email_lowercase",
    )
    // Nullable directory_users.email still permits NULL.
    await owner`
      insert into identity.directory_users (tenant_id, directory_id, user_name, email)
      values (${TENANT}, ${DIR}, ${`NoEmailUser@${DOMAIN}`}, null)
    `

    await expectCheckViolation(
      () =>
        owner`insert into identity.identities (tenant_id, connection_id, subject, clerk_user_id, email)
              values (${TENANT}, ${CONN}, ${`sub-bad-${RUN}`}, ${`${USER}_idbad`}, ${`Id@${DOMAIN}`})`,
      "identities_email_lowercase",
    )
    // Nullable identities.email still permits NULL.
    await owner`
      insert into identity.identities (tenant_id, connection_id, subject, clerk_user_id, email)
      values (${TENANT}, ${CONN}, ${`sub-null-${RUN}`}, ${`${USER}_idnull`}, null)
    `
  })

  it("real writers normalise mixed-case input and satisfy every CHECK", async () => {
    // suppressions/store.ts
    const sup = suppressionStore({
      db,
      ses: { remove: async () => "removed" } as never,
    })
    await sup.add(TENANT, `Suppressed-${RUN}@Example.Test`)
    const [supRow] = await owner<{ address: string }[]>`
      select address from core.suppressions
      where tenant_id = ${TENANT} and address = ${`suppressed-${RUN}@example.test`}
    `
    expect(supRow?.address).toBe(`suppressed-${RUN}@example.test`)

    // mailboxes/aliases.ts
    const aliasStore = mailboxAliases({ db, isAdmin: async () => true })
    const aliasRes = await aliasStore.add({
      tenantId: TENANT,
      address: `OWNER@${DOMAIN.toUpperCase()}`,
      alias: `Sales-Alias@${DOMAIN.toUpperCase()}`,
      actorId: USER,
    })
    expect(aliasRes.status).toBe("added")

    // team-inboxes/store.ts
    const teamStore = teamInboxStore(db)
    const team = await teamStore.create({
      tenantId: TENANT,
      name: `lc-${RUN}-team`,
      address: `Support-Team@${DOMAIN.toUpperCase()}`,
      displayName: "Support",
      memberUserIds: [USER],
    })
    expect(team.address).toBe(`support-team@${DOMAIN}`)

    // mailboxes/store.ts setRoute
    await db.transaction(async (tx) => {
      await directoryMail.setRoute(tx, {
        kind: "fwd",
        leaverId: USER,
        email: `Owner-Fwd@${DOMAIN.toUpperCase()}`,
        targetId: USER,
      })
    })
    const [fwdRow] = await owner<{ email: string }[]>`
      select email from authd.groups where name = ${`fwd-${USER}`}
    `
    expect(fwdRow?.email).toBe(`owner-fwd@${DOMAIN}`)

    // console/join.ts
    const joins = joinStore(db)
    const jd = await joins.addAccessDomain(TENANT, {
      name: `Join-Writer-${RUN}.Example`,
      clerkOrgId: `org_lc_${RUN}`,
      source: "txt",
    })
    expect(jd.outcome).toBe("created")
    await joins.exclude(TENANT, [`Excl-${RUN}@Example.Test`], "blocked")
    const excl = await joins.excluded(TENANT, [`excl-${RUN}@example.test`])
    expect(excl.get(`excl-${RUN}@example.test`)).toBe("blocked")

    // console/members-db.ts
    const members = memberStore(db)
    const invId = await members.createInvitation(TENANT, {
      clerkOrgId: `org_lc_${RUN}`,
      email: `Invitee-${RUN}@Example.Test`,
      role: "member",
      inviterUserId: USER,
      expiresAt: new Date(Date.now() + 86_400_000),
      zone: "UTC",
      country: null,
    })
    expect(invId).toBeTruthy()

    // mailboxes/jobs.ts
    const jobs = mailboxJobStore(db)
    const job = await jobs.insert({
      tenantId: TENANT,
      mailboxAddress: `Owner@${DOMAIN.toUpperCase()}`,
      type: "export",
      requestedBy: USER,
      status: "pending",
    })
    expect(job.mailboxAddress).toBe(`owner@${DOMAIN}`)

    // mail/storage.ts
    await withTenant(db, TENANT, async (tx) => {
      await tx.execute(
        recordMailboxUsageStatement(TENANT, [
          { address: `Owner@${DOMAIN.toUpperCase()}`, bytes: 4096 },
        ]),
      )
    })
    const [usageRow] = await owner<{ address: string }[]>`
      select address from core.mailbox_usage
      where tenant_id = ${TENANT} and address = ${`owner@${DOMAIN}`}
    `
    expect(usageRow?.address).toBe(`owner@${DOMAIN}`)

    // projection/writer.ts
    const projectedUser = `${USER}_proj`
    const projResult = await applyClerkEvent(
      db,
      `evt_lc_${RUN}_1`,
      "user.created",
      {
        id: projectedUser,
        first_name: "Ada",
        last_name: "Lovelace",
        primary_email_address_id: "em_1",
        updated_at: Date.now(),
        email_addresses: [
          {
            id: "em_1",
            email_address: `Ada.Proj@${DOMAIN.toUpperCase()}`,
            verification: { status: "verified" },
          },
          {
            id: "em_2",
            email_address: `Ada.Alt@${DOMAIN.toUpperCase()}`,
            verification: { status: "verified" },
          },
        ],
      },
      [DOMAIN],
    )
    expect(projResult).toEqual({
      outcome: "upserted",
      email: `ada.proj@${DOMAIN}`,
    })

    // identity/scim-store.ts createUser and editUser
    const dirStore = directoryStore(db)
    const scimCreated = await dirStore.createUser(
      TENANT,
      DIR,
      {
        userName: `Scim.User@${DOMAIN.toUpperCase()}`,
        externalId: `ext-${RUN}`,
        displayName: "Scim User",
        givenName: "Scim",
        familyName: "User",
        email: `  Scim.User@${DOMAIN.toUpperCase()} `,
        active: true,
        resource: { userName: `Scim.User@${DOMAIN.toUpperCase()}` },
      },
      { type: "scim.user.created" },
    )
    if (scimCreated === "taken") throw new Error("unexpected scim createUser taken")
    expect(scimCreated.row.email).toBe(`scim.user@${DOMAIN}`)
    const [scimRowAfterCreate] = await owner<{ email: string }[]>`
      select email from identity.directory_users where id = ${scimCreated.row.id}
    `
    expect(scimRowAfterCreate?.email).toBe(`scim.user@${DOMAIN}`)

    const scimEdited = await dirStore.editUser(
      TENANT,
      DIR,
      scimCreated.row.id,
      (before) => ({
        userName: before.userName,
        externalId: before.externalId,
        displayName: before.displayName,
        givenName: before.givenName,
        familyName: before.familyName,
        email: `  Scim.Edited@${DOMAIN.toUpperCase()} `,
        active: before.active,
        resource: before.resource,
      }),
      () => ({ type: "scim.user.updated" }),
    )
    if (!scimEdited || scimEdited === "taken") {
      throw new Error("unexpected scim editUser result")
    }
    expect(scimEdited.row.email).toBe(`scim.edited@${DOMAIN}`)
    const [scimRowAfterEdit] = await owner<{ email: string }[]>`
      select email from identity.directory_users where id = ${scimCreated.row.id}
    `
    expect(scimRowAfterEdit?.email).toBe(`scim.edited@${DOMAIN}`)

    // identity/store.ts link, touchIdentity, and provisionLocked().link
    const idStore = identityStore(db, null)
    const linked = await idStore.link(TENANT, {
      connectionId: CONN,
      subject: `sub-link-${RUN}`,
      clerkUserId: `${USER}_idlink`,
      email: `  Link.User@${DOMAIN.toUpperCase()} `,
    })
    const [linkedRow] = await owner<{ email: string }[]>`
      select email from identity.identities where id = ${linked.id}
    `
    expect(linkedRow?.email).toBe(`link.user@${DOMAIN}`)

    await idStore.touchIdentity(
      TENANT,
      linked.id,
      `  Touched.User@${DOMAIN.toUpperCase()} `,
      new Date(),
    )
    const [touchedRow] = await owner<{ email: string }[]>`
      select email from identity.identities where id = ${linked.id}
    `
    expect(touchedRow?.email).toBe(`touched.user@${DOMAIN}`)

    const locked = await idStore.provisionLocked(
      TENANT,
      { connectionId: CONN, email: `locked.user@${DOMAIN}` },
      (lock) =>
        lock.link({
          subject: `sub-locked-${RUN}`,
          clerkUserId: `${USER}_idlocked`,
          email: `  Locked.User@${DOMAIN.toUpperCase()} `,
        }),
    )
    const [lockedRow] = await owner<{ email: string }[]>`
      select email from identity.identities where id = ${locked.id}
    `
    expect(lockedRow?.email).toBe(`locked.user@${DOMAIN}`)

    // mailboxes/store.ts directoryMail.setAliases and directoryMail.mirrorGroup
    const dirAliasResult = await db.transaction((tx) =>
      directoryMail.setAliases(tx, USER, [`  Dir.Alias@${DOMAIN.toUpperCase()} `]),
    )
    expect(dirAliasResult.taken).toEqual([])
    const [dirAliasRow] = await owner<{ address: string }[]>`
      select address from authd.aliases
      where clerk_user_id = ${USER} and source = 'directory'
    `
    expect(dirAliasRow?.address).toBe(`dir.alias@${DOMAIN}`)

    const [dirGroup] = await owner<{ id: string }[]>`
      insert into identity.directory_groups (tenant_id, directory_id, display_name)
      values (${TENANT}, ${DIR}, ${`LC Group ${RUN}`})
      returning id
    `
    const mirrorStatus = await db.transaction((tx) =>
      directoryMail.mirrorGroup(tx, {
        name: `lc-${RUN}-dir-group`,
        email: `  Dir.Group@${DOMAIN.toUpperCase()} `,
        description: "Directory Group",
        directoryGroupId: dirGroup!.id,
      }),
    )
    expect(mirrorStatus).toBe("mirrored")
    const [mirroredRow] = await owner<{ email: string }[]>`
      select email from authd.groups where name = ${`lc-${RUN}-dir-group`}
    `
    expect(mirroredRow?.email).toBe(`dir.group@${DOMAIN}`)

    // webhooks/db.ts suppressOnly and record
    const webhookOps = webhookEventOps({ db, queue: {} as never })
    const whMessageId = crypto.randomUUID()
    const whNow = new Date()
    await webhookOps.suppressOnly!({
      tenantId: TENANT,
      event: {
        type: "email.bounced",
        messageId: whMessageId,
        occurredAt: whNow,
        sourceEventId: `sns_lc_${RUN}_suppress_only`,
        suppress: [
          {
            address: `  Bounce.Only@${DOMAIN.toUpperCase()} `,
            reason: "hard_bounce",
          },
        ],
        data: { from: `sender@${DOMAIN}` },
        raw: {},
      },
    })
    const [supOnlyRow] = await owner<{ address: string }[]>`
      select address from core.suppressions
      where tenant_id = ${TENANT} and address = ${`bounce.only@${DOMAIN}`}
    `
    expect(supOnlyRow?.address).toBe(`bounce.only@${DOMAIN}`)

    const recordRes = await webhookOps.record({
      tenantId: TENANT,
      messageCreatedAt: whNow,
      event: {
        type: "email.complained",
        messageId: whMessageId,
        occurredAt: whNow,
        sourceEventId: `sns_lc_${RUN}_record`,
        suppress: [
          {
            address: `  Complaint.Rec@${DOMAIN.toUpperCase()} `,
            reason: "complaint",
          },
        ],
        data: { from: `sender@${DOMAIN}` },
        raw: {},
      },
    })
    expect(recordRes).toEqual({ status: "recorded", deliveries: [] })
    const [supRecRow] = await owner<{ address: string }[]>`
      select address from core.suppressions
      where tenant_id = ${TENANT} and address = ${`complaint.rec@${DOMAIN}`}
    `
    expect(supRecRow?.address).toBe(`complaint.rec@${DOMAIN}`)

    // webhooks/stalwart-account-db.ts recordAuthFailure
    const accountOps = accountEventOps(db)
    const authFailRes = await accountOps.recordAuthFailure({
      owner: { clerkUserId: USER, tenantId: TENANT },
      event: {
        type: "auth.failed",
        account: `  Owner.AuthFail@${DOMAIN.toUpperCase()} `,
        ip: "198.51.100.42",
        listener: "imap",
        occurredAt: new Date(),
        sourceEventId: `evt_lc_${RUN}_authfail`,
      },
    })
    expect(authFailRes).toBe("recorded")
    const [authFailRow] = await owner<{ account: string }[]>`
      select account from core.mailbox_auth_failures
      where tenant_id = ${TENANT} and account = ${`owner.authfail@${DOMAIN}`}
    `
    expect(authFailRow?.account).toBe(`owner.authfail@${DOMAIN}`)
  })
})
