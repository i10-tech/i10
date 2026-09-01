import { relations } from "drizzle-orm"
import {
  boolean,
  index,
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
 * The Clerk projection — a read model of Clerk's users, maintained by webhook.
 *
 * ⚠ THIS SCHEMA HAS TWO READERS IN TWO LANGUAGES. `services/authd` (Go, pgx)
 * queries these tables directly to answer Stalwart's LDAP searches. Drizzle is
 * the single source of truth for the DDL and authd never writes; but a column
 * renamed here silently breaks authd's queries, which are plain SQL and will
 * not fail to compile. Changing a column name means changing both, together.
 *
 * It exists so that LDAP searches cost zero Clerk API calls. Clerk allows 1000
 * requests per 10 seconds across all of i10, and IMAP clients are chatty —
 * Apple Mail opens several connections per account and re-authenticates on a
 * timer. Serving filterLogin, filterMailbox and filterMemberOf from here means
 * only the bind itself reaches Clerk: one call per authentication, none per
 * delivery.
 *
 * Nothing here is authoritative. Where it disagrees with Clerk, Clerk wins and
 * the projection is repaired. In particular there is NO password material of
 * any kind — no hash, no verifier, no salt. Stalwart runs with
 * bindAuthentication=true and never reads a password attribute.
 */
export const authd = pgSchema("authd")

export const accounts = authd.table("accounts", {
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
   * Clerk webhooks must never set this — identity events say nothing about
   * whether an invoice cleared.
   */
  active: boolean("active").notNull().default(false),

  /**
   * The tenant whose domain this mailbox is on, once mailboxes are sold to
   * anyone but us.
   *
   * ⚠ NULLABLE, AND NOT YET WRITTEN. i10's own mailboxes on i10.tech predate
   * tenancy and have no owner row; a NOT NULL column would have to invent one.
   * It is here now because the table is empty now — adding a column to a
   * populated projection means a backfill against Clerk, and adding it later is
   * the only version of this change that costs anything.
   *
   * Not a foreign key to `core.tenants`: authd holds SELECT on this schema and
   * nothing else, and an FK would make its inserts depend on a table it cannot
   * see. The reference is enforced by the API, which owns both sides.
   */
  tenantId: uuid("tenant_id"),

  /**
   * Clerk's own `updated_at` for this user, and the column does two jobs.
   *
   * authd serves it to Stalwart as `pwdChangeTime` (attrSecretChanged), which
   * Stalwart compares to decide when cached OAuth tokens are stale. Clerk
   * publishes no password-specific timestamp, so this is the closest available
   * signal — and it errs safely: it moves on any profile change, invalidating
   * tokens MORE often than strictly needed, never less. A password change that
   * failed to move it would leave tokens minted under the old password valid.
   *
   * It is also the ordering guard. Webhook delivery is unordered, so a write is
   * applied only when the incoming value is at least the stored one; otherwise
   * a delayed older event would overwrite a newer state.
   */
  clerkUpdatedAt: timestamp("clerk_updated_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

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

export const groups = authd.table("groups", {
  name: text("name").primaryKey(),
  email: text("email").unique(),
  description: text("description"),
})

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
