import { relations, sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"

// The transactional product. Re-exported so drizzle-kit and `import * as
// schema` both see one entry point, rather than two that can disagree.
export * from "./core.js"

/**
 * The Clerk projection - a read model of Clerk's users, maintained by webhook.
 *
 * ⚠ THIS SCHEMA HAS TWO READERS IN TWO LANGUAGES. `services/authd` (Go, pgx)
 * queries these tables directly to answer Stalwart's LDAP searches. Drizzle is
 * the single source of truth for the DDL and authd never writes; but a column
 * renamed here silently breaks authd's queries, which are plain SQL and will
 * not fail to compile. Changing a column name means changing both, together.
 *
 * It exists so that LDAP searches cost zero Clerk API calls. Clerk allows 1000
 * requests per 10 seconds across all of i10, and IMAP clients are chatty -
 * Apple Mail opens several connections per account and re-authenticates on a
 * timer. Serving filterLogin, filterMailbox and filterMemberOf from here means
 * only the bind itself reaches Clerk: one call per authentication, none per
 * delivery.
 *
 * Nothing here is authoritative. Where it disagrees with Clerk, Clerk wins and
 * the projection is repaired. In particular there is NO password material of
 * any kind - no hash, no verifier, no salt. Stalwart runs with
 * bindAuthentication=true and never reads a password attribute.
 */
export const authd = pgSchema("authd")

export const accounts = authd.table(
  "accounts",
  {
    clerkUserId: text("clerk_user_id").primaryKey(),

    /**
     * The primary mailbox address, stored lowercased.
     *
     * ⚠ ONLY ADDRESSES IN DOMAINS i10 HOSTS. A row here makes Stalwart treat the
     * address as a LOCAL RECIPIENT. Projecting a user's Gmail would have Stalwart
     * accept and swallow mail addressed to gmail.com. See `projectUser`.
     */
    email: text("email").notNull().unique(),

    displayName: text("display_name"),
    description: text("description"),

    /**
     * The subscription gate, and the reason this is not derived from Clerk.
     *
     * Signing up is not the same as paying. An inactive account is INVISIBLE:
     * filterMailbox stops returning it, Stalwart refuses mail for the address,
     * and binds fail. That takes effect on the next query rather than on a
     * reconciliation run, which is what SCIM deprovisioning would have bought us.
     *
     * Clerk webhooks must never set this - identity events say nothing about
     * whether an invoice cleared.
     */
    active: boolean("active").notNull().default(false),

    /**
     * The tenant whose domain this mailbox is on, once mailboxes are sold to
     * anyone but us.
     *
     * ⚠ NULLABLE, AND NOT YET WRITTEN. i10's own mailboxes on i10.tech predate
     * tenancy and have no owner row; a NOT NULL column would have to invent one.
     * It is here now because the table is empty now - adding a column to a
     * populated projection means a backfill against Clerk, and adding it later is
     * the only version of this change that costs anything.
     *
     * Not a foreign key to `core.tenants`: authd holds SELECT on this schema and
     * nothing else, and an FK would make its inserts depend on a table it cannot
     * see. The reference is enforced by the API, which owns both sides.
     */
    tenantId: uuid("tenant_id"),

    /**
     * The storage an owner or admin allocated to this mailbox, in bytes.
     *
     * ⚠ OUR DATABASE IS THE SOURCE OF TRUTH, and Stalwart's `maxDiskQuota` is a
     * copy of it (mail/quota.ts). On a plan workspace the allocations of all its
     * inboxes sum to at most the plan's prepaid storage; on PAYG one is an
     * optional cap. Null means none: PAYG uncapped, or an inbox that predates
     * allocation on a plan workspace (reported as `unallocated`, and given the
     * high default quota so nothing live bounces).
     *
     * ⚠ POSITIVE, OR NULL, NEVER ZERO. Whether Stalwart reads a quota of 0 as
     * "none" or as "unlimited" was not probed, so zero is not a value we send.
     */
    storageAllocation: bigint("storage_allocation", { mode: "number" }),

    /**
     * Clerk's own `updated_at` for this user, and the column does two jobs.
     *
     * authd serves it to Stalwart as `pwdChangeTime` (attrSecretChanged), which
     * Stalwart compares to decide when cached OAuth tokens are stale. Clerk
     * publishes no password-specific timestamp, so this is the closest available
     * signal - and it errs safely: it moves on any profile change, invalidating
     * tokens MORE often than strictly needed, never less. A password change that
     * failed to move it would leave tokens minted under the old password valid.
     *
     * It is also the ordering guard. Webhook delivery is unordered, so a write is
     * applied only when the incoming value is at least the stored one; otherwise
     * a delayed older event would overwrite a newer state.
     */
    clerkUpdatedAt: timestamp("clerk_updated_at", { withTimezone: true }),

    /**
     * Raised to kill every cached password verification for this person, on every
     * Stalwart pod at once.
     *
     * authd remembers a verified password for hours (`AUTHD_CRED_CACHE_TTL`) and
     * compares this column on every hit, so bumping it is the instant way to make
     * the next bind ask the identity provider again. That is the only reason the
     * cache can be that long.
     *
     * ⚠ FOR REVOCATIONS THAT LEAVE THE ROW ACTIVE AND DO NOT MOVE
     * `clerk_updated_at`. A password change in Clerk already moves that, and a
     * deleted or deactivated row is turned away before the cache is consulted, so
     * neither needs this. Raise it with `raiseCredentialEpoch`, never with a bare
     * UPDATE: the increment has to be one statement or two writers can lose one.
     *
     * Only ever compared for equality, so it can be bumped by any amount.
     */
    credentialEpoch: bigint("credential_epoch", { mode: "number" })
      .notNull()
      .default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "accounts_storage_allocation_positive",
      sql`${t.storageAllocation} is null or ${t.storageAllocation} > 0`,
    ),
  ],
)

export const aliases = authd.table(
  "aliases",
  {
    address: text("address").primaryKey(),
    clerkUserId: text("clerk_user_id")
      .notNull()
      .references(() => accounts.clerkUserId, { onDelete: "cascade" }),
  },
  (t) => [index("aliases_account_idx").on(t.clerkUserId)],
)

export const groups = authd.table(
  "groups",
  {
    name: text("name").primaryKey(),
    email: text("email").unique(),
    description: text("description"),

    /**
     * The workspace a team inbox belongs to.
     *
     * ⚠ NULLABLE, AND A NULL GROUP IS NOT A TEAM INBOX. Every group the API
     * writes has an owner; the column is nullable for the same reason
     * `accounts.tenant_id` is, and a team inbox is found by this column, never
     * by the shape of the name. Not a foreign key, for the reason given there.
     */
    tenantId: uuid("tenant_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("groups_tenant_idx").on(t.tenantId)],
)

/**
 * Which messages the server has already copied into a team inbox's Sent.
 *
 * ⚠ THE MESSAGE-ID IS THE KEY, AND THIS IS WHAT MAKES THE COPY SAFE TO REPEAT.
 * The pass that fills a team inbox's Sent runs on a schedule and looks back over
 * a window, so the same sent message is seen many times. See
 * `team-inboxes/sent-copy.ts`.
 */
export const groupSentCopies = authd.table(
  "group_sent_copies",
  {
    groupName: text("group_name")
      .notNull()
      .references(() => groups.name, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    copiedAt: timestamp("copied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupName, t.messageId] })],
)

export const groupMembers = authd.table(
  "group_members",
  {
    groupName: text("group_name")
      .notNull()
      .references(() => groups.name, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id")
      .notNull()
      .references(() => accounts.clerkUserId, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.groupName, t.clerkUserId] }),
    index("group_members_account_idx").on(t.clerkUserId),
  ],
)

/**
 * Webhook delivery is at-least-once and unordered.
 *
 * Recording the Svix message id makes replays idempotent. Out-of-order delivery
 * is the harder problem, and it is handled separately by comparing
 * `accounts.clerk_updated_at` on write.
 */
export const webhookEvents = authd.table("webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * How many failed passwords authd has forwarded to an identity provider for one
 * person in the current window.
 *
 * An IdP such as Okta locks the REAL company account after about ten failures,
 * and i10 must never be what spends them. authd counts the failures it forwards
 * here and stops forwarding while the budget is spent. It is a table rather than
 * memory because both Stalwart pods run an authd, and a count kept per pod would
 * let each forward its own share.
 *
 * ⚠ NO PASSWORD MATERIAL, NOT EVEN A HASH. A counter and the instant its window
 * opened, keyed by Clerk user id. Anything derived from the password stays in
 * authd's memory (`internal/credcache`).
 *
 * ⚠ THE ONLY TABLE IN `authd` THAT THE `authd` ROLE WRITES. Everything else is
 * the API's; 0138 grants authd INSERT and UPDATE on this one table and nothing
 * more. Not a foreign key to `accounts`: a budget outliving a re-created account
 * is harmless, and the role has no business depending on that table's rows.
 *
 * Inert for Clerk, whose verify_password was measured not to feed lockout. It is
 * here ahead of the first provider that needs it.
 */
export const bindFailureBudget = authd.table("bind_failure_budget", {
  clerkUserId: text("clerk_user_id").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
})

export const accountsRelations = relations(accounts, ({ many }) => ({
  aliases: many(aliases),
  memberships: many(groupMembers),
}))

export const aliasesRelations = relations(aliases, ({ one }) => ({
  account: one(accounts, {
    fields: [aliases.clerkUserId],
    references: [accounts.clerkUserId],
  }),
}))

export const groupsRelations = relations(groups, ({ many }) => ({
  members: many(groupMembers),
}))

export const groupMembersRelations = relations(groupMembers, ({ one }) => ({
  group: one(groups, { fields: [groupMembers.groupName], references: [groups.name] }),
  account: one(accounts, {
    fields: [groupMembers.clerkUserId],
    references: [accounts.clerkUserId],
  }),
}))
