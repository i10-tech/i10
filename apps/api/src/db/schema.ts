import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core"
import { tenants } from "./core.js"
import { connections, directoryGroups, managedAccounts } from "./identity.js"

// The transactional product. Re-exported so drizzle-kit and `import * as
// schema` both see one entry point, rather than two that can disagree.
export * from "./core.js"
// Enterprise identity (#337): its own schema, the same tenant boundary.
export * from "./identity.js"

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
     *
     * ⚠ A NEW ROW STARTS FROM THE CLOCK, NEVER FROM ZERO. The row is deleted when
     * a person gives up their hosted address or their mailbox is deleted, and
     * made again if they come back; a counter that restarts at 0 can land on a
     * number authd cached a password under BEFORE the revocation that raised it,
     * and the revoked password would match again. Microseconds since 1970 only
     * ever grow, so a recreated row's seed is above anything the old one reached
     * (raising adds 1; it would take one raise per microsecond to catch up). It
     * stays below 2^53 until the year 2255, so a JS number holds it exactly.
     */
    credentialEpoch: bigint("credential_epoch", { mode: "number" })
      .notNull()
      .default(sql`(extract(epoch from clock_timestamp()) * 1000000)::bigint`),

    /**
     * Set when a company's directory switched the person off (#344): the mailbox
     * still EXISTS and still receives mail, but nobody can log in to it.
     *
     * ⚠ NOT `active`, AND THAT IS THE POINT. `active` makes an account invisible
     * (no delivery, no bind); suspension must keep delivering. authd refuses the
     * bind for a row with this set and answers every search as before.
     *
     * ⚠ ONE WRITER: mailboxes/store.ts. The projection's upsert must never name
     * this column, or a profile edit would lift a suspension.
     */
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),

    /**
     * Set while the workspace's paid plan has lapsed (billing/grants.ts): the
     * mailbox still EXISTS and still receives mail, but nobody can log in to it,
     * and paying again clears it.
     *
     * ⚠ NOT `suspended_at`, BECAUSE THE TWO ARE LIFTED BY DIFFERENT PEOPLE.
     * Payment lifts this one on its own; `suspended_at` is a person's leaving, a
     * company's directory or an owner, and a paying workspace must never get back
     * the login of somebody it removed. authd refuses a bind for either, ahead of
     * the credential cache.
     *
     * ⚠ ONE WRITER: `mailAccess` in mailboxes/store.ts. The projection's upsert
     * must never name this column.
     */
    paymentHoldAt: timestamp("payment_hold_at", { withTimezone: true }),

    /**
     * Set while an owner or admin has the mailbox in its 30 day deletion grace
     * (mailboxes/lifecycle.ts): the mailbox still EXISTS and still receives mail,
     * but nobody can log in to it, and only a restore clears it.
     *
     * ⚠ A COLUMN OF ITS OWN, NOT `suspended_at`. Every resume path (the owner's,
     * the directory's) clears `suspended_at`, and a deletion must survive all of
     * them; sharing the column would also make a restore guess whether the
     * suspension it found was its own. authd refuses a bind for it ahead of the
     * credential cache, from the row the bind already holds.
     *
     * ⚠ ONE WRITER: `mailboxDeletions` in mailboxes/lifecycle-store.ts, in the
     * transaction of its `core.mailbox_deletions` row. The projection's upsert
     * must never name this column.
     */
    deletingAt: timestamp("deleting_at", { withTimezone: true }),

    /**
     * Clerk's `banned`, `locked` and the end of a lockout for this user, projected
     * by the webhook (projection/clerk-user.ts).
     *
     * ⚠ PROBED AGAINST CLERK'S DEV INSTANCE 2026-11-07: verify_password ANSWERS
     * 200 `verified: true` FOR A BANNED USER AND FOR A LOCKED ONE. Clerk refuses
     * them at its own sign-in, not at that endpoint, so without these columns
     * authd would go on letting them in - and a password verified before the ban
     * sits in its cache besides. The bind refuses them itself, ahead of the cache.
     *
     * ⚠ A LOCKOUT ENDS BY ITSELF (`lockout_expires_in_seconds`, an hour for the
     * lock endpoint) AND CLERK SAYS NOTHING WHEN IT DOES; unlocking by hand does
     * not even move `updated_at`. So a lock is `locked` AND not yet past
     * `locked_until`: it lifts on its own clock, and a webhook that never comes
     * can keep somebody out for at most that long. A null `locked_until` on a
     * locked row is indefinite.
     */
    banned: boolean("banned").notNull().default(false),
    locked: boolean("locked").notNull().default(false),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("accounts_email_lowercase", sql`"email" = lower("email")`),
    check(
      "accounts_storage_allocation_positive",
      sql`${t.storageAllocation} is null or ${t.storageAllocation} > 0`,
    ),
    // The purge pass lists deleting mailboxes of every workspace; there are few.
    index("accounts_deleting_idx")
      .on(t.deletingAt)
      .where(sql`${t.deletingAt} is not null`),
  ],
)

export const aliases = authd.table(
  "aliases",
  {
    address: text("address").primaryKey(),
    clerkUserId: text("clerk_user_id")
      .notNull()
      .references(() => accounts.clerkUserId, { onDelete: "cascade" }),
    /**
     * `clerk` (a verified address on the Clerk user, replaced wholesale by the
     * projection), `directory` (an address a company's directory lists, #344,
     * written only by mailboxes/store.ts) or `console` (an owner or admin gave it,
     * B8, written only by mailboxes/aliases.ts).
     *
     * ⚠ THE PROJECTION REPLACES ONLY ITS OWN. Without the split, the next
     * `user.updated` webhook would delete every alias a directory gave.
     *
     * ⚠ `console` IS NOT A CLERK ADDRESS ON PURPOSE. A verified address on the Clerk
     * user is also a way to sign in as that person, and an alias on a second domain
     * of the workspace should not become one; nor should a mailbox's aliases depend
     * on a Clerk round trip that can fail after the row is written.
     */
    source: text("source").notNull().default("clerk"),
  },
  (t) => [
    index("aliases_account_idx").on(t.clerkUserId),
    check("aliases_address_lowercase", sql`"address" = lower("address")`),
    check("aliases_source_check", sql`"source" in ('clerk', 'directory', 'console')`),
  ],
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

    /**
     * The directory group this list was made from (#344), or null for any other
     * group. The foreign key is the backstop: a group deleted by its directory,
     * or a workspace deleted, takes its list (and the list's members) with it.
     */
    directoryGroupId: uuid("directory_group_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("groups_tenant_idx").on(t.tenantId),
    check("groups_email_lowercase", sql`"email" is null or "email" = lower("email")`),
    foreignKey({
      name: "authd_groups_directory_group_fk",
      columns: [t.directoryGroupId],
      foreignColumns: [directoryGroups.id],
    }).onDelete("cascade"),
  ],
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
 * Which accounts a company's SSO connection manages (#344), as authd needs it.
 *
 * A mirror of `identity.managed_accounts`, which authd cannot read: that table
 * is behind row-level security and authd holds SELECT on this schema only.
 *
 * ⚠ A SEPARATE TABLE, NOT A COLUMN ON `accounts`, BECAUSE A MANAGED ACCOUNT MUST
 * BE MANAGED BEFORE IT HAS A MAILBOX ROW. `accounts` is written when a mailbox
 * is provisioned; the claim happens when SSO links the person. A flag on the
 * mailbox row would be unset in the gap between the two, and an unset flag
 * means "ask Clerk" - the one thing a managed account must never do.
 *
 * ⚠ ONE WRITER: identity/authd-mirror.ts, called from the same transaction as
 * every change to `identity.managed_accounts`. The foreign keys are the
 * backstop for what the API does not do itself - a workspace deleted takes its
 * managed rows with it (cascade), a connection deleted leaves the account
 * managed by NOTHING (set null), which authd refuses. Neither frees an account
 * to be asked of Clerk while its company still owns it.
 */
export const authdManagedAccounts = authd.table(
  "managed_accounts",
  {
    clerkUserId: text("clerk_user_id").primaryKey(),
    /** The connection whose pass-through answers this account's binds. Null: none. */
    connectionId: uuid("connection_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Named by hand: the generated name is past Postgres's 63 characters and
    // would be truncated in the database but not in the snapshot.
    foreignKey({
      name: "authd_managed_user_fk",
      columns: [t.clerkUserId],
      foreignColumns: [managedAccounts.clerkUserId],
    }).onDelete("cascade"),
    foreignKey({
      name: "authd_managed_connection_fk",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("set null"),
    // The people of one connection: `mirrorPassthrough` raises their epoch when
    // its settings move, and the `set null` above finds them when it is deleted.
    // Without it both read every managed account (EXPLAIN on 50,000 rows: a seq
    // scan, 368 buffers, to update 25).
    index("authd_managed_connection_idx").on(t.connectionId),
  ],
)

/**
 * The domains whose people must sign in through SSO, as authd needs it.
 *
 * A mirror of what `identity.connections` and `identity.connection_domains`
 * say, which authd cannot read: a domain is here while an ACTIVE connection with
 * enforcement "required_domain" or "required_all" covers it with a live proof.
 * authd refuses the Clerk password of an account that is on one of these and is
 * not managed (internal/passthrough ManagedResolver), so the person has to go
 * through SSO, which makes them managed and moves their mail password to the
 * company's directory.
 *
 * ⚠ A DOMAIN, NOT A FLAG ON EACH ACCOUNT, SO A MAILBOX MADE LATER IS COVERED THE
 * MOMENT IT EXISTS and nothing has to remember to flag it. Turning enforcement
 * off, deactivating the connection or losing the proof removes the row, which
 * is what restores the Clerk password.
 *
 * ⚠ ONE WRITER: identity/authd-mirror.ts (`mirrorRequiredDomains`), called from
 * the same transaction as every change that can move the answer. The foreign
 * keys are the backstop: a connection or a workspace deleted takes its rows
 * with it.
 */
export const authdRequiredDomains = authd.table(
  "required_domains",
  {
    domain: text("domain").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("required_domains_tenant_idx").on(t.tenantId),
    check("required_domains_domain_lowercase", sql`"domain" = lower("domain")`),
    foreignKey({
      name: "authd_required_connection_fk",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("cascade"),
  ],
)

/**
 * Who keeps their Clerk password for mail on a required domain, as authd needs it.
 *
 * "Required" refuses the Clerk password of every account that is not managed
 * (`required_domains`). The people SSO itself exempts keep it, as they keep their
 * way into the console: owners and admins while the workspace's owner exemption is
 * on (`owner_exemption`), and whoever a connection's bypass list names (`bypass`).
 * A row says "this person is exempt from THIS connection's requirement", and
 * authd reads it beside the required domain in the one account query.
 *
 * ⚠ EVERY ROW IS A PASS, SO A ROW LEFT BEHIND IS A REVOCATION THAT NEVER HAPPENED.
 * Nothing here is a flag that somebody has to remember to clear: the whole
 * workspace's set is RECOMPUTED from the roles, the settings, the bypass lists and
 * `required_domains` (identity/authd-mirror.ts `mirrorRequiredExempt`), under one
 * lock per workspace, in the same transaction as every change to any of them.
 * Removing somebody from the bypass list or the exemption, demoting an admin,
 * removing a member or turning "required" off all end in a recompute that no longer
 * lists them, and authd reads that at the next bind, ahead of its credential cache.
 *
 * ⚠ NOTHING HERE EXPIRES, AND THAT IS THE SOURCES' DOING, NOT THIS TABLE'S. The
 * bypass list has no end date and the owner exemption is a switch (its two-owner
 * request to turn it off times out, but the exemption stays ON until approved), so
 * there is no moment for a clock to lift. A source that gains an expiry must put it
 * in this table's recompute AND in authd's query (`expires_at > now()`): a recompute
 * only runs when something is written, and a lapse writes nothing.
 *
 * ⚠ ONE WRITER: identity/authd-mirror.ts. The foreign keys are the backstop: a
 * connection or a workspace deleted takes its rows with it.
 */
export const authdRequiredExempt = authd.table(
  "required_exempt",
  {
    connectionId: uuid("connection_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    /** `owner_exemption` (an owner or admin while the exemption is on) or `bypass` (a connection's list). */
    source: text("source").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.clerkUserId, t.source] }),
    index("required_exempt_tenant_idx").on(t.tenantId),
    foreignKey({
      name: "authd_exempt_connection_fk",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("cascade"),
    check(
      "required_exempt_source_check",
      sql`"source" in ('owner_exemption', 'bypass')`,
    ),
  ],
)

/**
 * One version per SSO connection of what its mail pass-through answers
 * (`passthroughFor` in identity/ldap.ts), so authd can tell when a copy of the
 * settings it holds is older than the database.
 *
 * ⚠ IT MOVES IN THE SAME TRANSACTION AS THE CHANGE, AND THE ACCOUNTS' EPOCHS WITH
 * IT. `fingerprint` is a hash of exactly what `passthroughFor` reads: whether the
 * connection is active, whether a live proof backs it, its provider, its `ldap`
 * and `oidcMail` settings and its sealed secrets. identity/authd-mirror.ts
 * `mirrorPassthrough` recomputes it in the transaction of every change that can
 * move any of those, and when it differs raises `version` and the
 * `credential_epoch` of every account the connection manages, together. A crash
 * leaves the change, the version and the epochs together or none of them.
 *
 * ⚠ WHAT THE VERSION IS FOR. authd keeps a connection's settings for up to a
 * minute (services/authd/internal/passthrough MaxCacheTTL). The bind's account
 * query reads this version, and a copy older than it is fetched again, so a
 * sign-in after a change is never checked against the settings it replaced. The
 * epoch raise ends what was already open: authd's cached successes and the mail
 * front's sessions. Before this table the API raised the epochs after the change
 * committed and once more a minute later from a timer, and a failure or a restart
 * in between left sessions open for good.
 *
 * ⚠ ONE WRITER: identity/authd-mirror.ts. A connection deleted takes its row.
 */
export const authdPassthroughVersions = authd.table(
  "passthrough_versions",
  {
    connectionId: uuid("connection_id").primaryKey(),
    version: bigint("version", { mode: "number" }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "authd_passthrough_connection_fk",
      columns: [t.connectionId],
      foreignColumns: [connections.id],
    }).onDelete("cascade"),
  ],
)

/** A 64-bit transaction id (`xid8`), which Drizzle has no column type for. Read as text. */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => "xid8",
})

/**
 * Which keys of the mail gate changed, and in which transaction: the mail front
 * re-checks only the open connections these name, instead of every one, every
 * second (services/authd/internal/mailfront, README "The sweep").
 *
 * ⚠ WRITTEN ONLY BY TRIGGERS, ON EVERY TABLE THE GATE READS. A statement-level
 * trigger on each of them (`authd.log_access_change`, migration
 * `*_access_change_triggers`) inserts one row per distinct key a statement
 * touched, old and new: `account` (a Clerk user id), `domain` (a lowercased mail
 * domain), `connection` (an SSO connection id), or `all` for a TRUNCATE. Nothing
 * else may write here: the API and authd hold no grant on it, and a table the
 * gate starts reading without a trigger fails
 * `TestEveryTableTheGateReadsLogsItsChanges` (services/authd/internal/projection).
 *
 * ⚠ `txid` IS THE ORDER, NOT `id`. Both are taken before commit, so a
 * transaction that commits late lands below rows the front has already read.
 * The front reads by snapshot instead (`projection.AccessChanges`): the rows of
 * every transaction that was not yet visible in its previous snapshot, found by
 * an index range scan from that snapshot's xmax (`txid >= xmax`) UNION ALL an
 * index lookup per in-progress transaction (`txid = ANY(xip)`).
 *
 * ⚠ ROWS LIVE AN HOUR. `authd.prune_access_changes()` deletes older ones from
 * the hourly retention job (retention.ts). The front needs a row for about a
 * second, and falls back to a full sweep once a minute and after ten minutes
 * without a successful read, so nothing it depends on is that old.
 */
export const accessChanges = authd.table(
  "access_changes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    txid: xid8("txid")
      .notNull()
      .default(sql`pg_current_xact_id()`),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("access_changes_txid_idx").on(t.txid),
    check(
      "access_changes_kind_check",
      sql`${t.kind} in ('account', 'domain', 'connection', 'all')`,
    ),
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
