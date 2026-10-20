import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { joinDomains, tenants } from "./core.js"

/**
 * Enterprise identity (#337, docs/decisions/sso.md 2.3): SSO connections, the
 * links from an IdP's subjects to Clerk users, the bridge's short-lived
 * attempts, the sessions it bound, and the audit log.
 *
 * ⚠ ITS OWN SCHEMA, AND THE SAME TENANT BOUNDARY AS `core`. Every table carries
 * `tenant_id` and a workspace policy on `app.tenant_id`, and `assertRlsSubject`
 * checks this schema as it checks `core`. The grants for `i10_api` are the one
 * hand-made part (migration 0134, `drizzle-kit generate --custom`): Drizzle
 * does not model GRANT, and 0002's default privileges only cover `core`.
 *
 * ⚠ EVERY REFERENCE TO A CONNECTION OR A PROOF CARRIES THE TENANT TOO, as a
 * composite foreign key on `(id, tenant_id)`. A foreign key is checked
 * without RLS, so a plain one would let a row in workspace A point at
 * workspace B's connection or domain proof if any code path ever passed the
 * wrong id; the composite one makes that impossible in the database itself.
 *
 * ⚠ THE OTHER AUDIENCES ARE NARROW POLICIES ON ONE SETTING EACH, as in `core`
 * (`join_requests_seeker_read`, `member_invitations_link_read`). The gate
 * knows only a Clerk user, the gateway only an identifier, the browser only a
 * hash of something it holds; each reads exactly the rows that value names,
 * and every WRITE then happens under `withTenant` with the tenant taken from
 * the row it read, never from the request.
 */
export const identity = pgSchema("identity")

/**
 * One SSO connection of a workspace.
 *
 * ⚠ ONLY `active` SIGNS ANYBODY IN, AND ONLY `active` KEEPS A BOUND SESSION
 * ALIVE. `testing` runs test runs (claims recorded, nobody signed in); a
 * `disabled` connection's managed accounts are refused by the gate until it is
 * active again - break-glass is #340.
 *
 * ⚠ `secrets` IS SEALED WITH THE WEBHOOK SECRET BOX (`secretBox`, the box that
 * already keeps webhook signing secrets and DKIM keys), never stored plain. It
 * holds a JSON object the engine defines (#338: the OIDC client secret).
 */
export const connections = identity.table(
  "connections",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    protocol: text("protocol").notNull(),
    /** `okta`, `entra`, `google`, `generic`... the setup guide's preset. */
    provider: text("provider").notNull().default("generic"),
    status: text("status").notNull().default("draft"),
    /** Protocol settings (issuer, metadata URL, client id...). Never a secret. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Sealed JSON, see above. */
    secrets: text("secrets"),
    enforcement: text("enforcement").notNull().default("off"),
    jitEnabled: boolean("jit_enabled").notNull().default(false),
    /** Require proof of IdP MFA (`amr` / `AuthnContextClassRef`). */
    mfaRequired: boolean("mfa_required").notNull().default(false),
    /** A bound session's longest life, from its bind. Null: Clerk's own. */
    maxSessionSeconds: integer("max_session_seconds"),
    /** How long a bound session may go unused. Null: no idle limit. */
    idleTimeoutSeconds: integer("idle_timeout_seconds"),
    /** IdP attribute -> our field. */
    attributeMapping: jsonb("attribute_mapping")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("connections_tenant_idx").on(t.tenantId),
    unique("connections_id_tenant_unique").on(t.id, t.tenantId),
    check("connections_protocol_check", sql`"protocol" in ('oidc', 'saml', 'test')`),
    check(
      "connections_status_check",
      sql`"status" in ('draft', 'testing', 'active', 'disabled')`,
    ),
    check(
      "connections_enforcement_check",
      sql`"enforcement" in ('off', 'optional', 'required_domain', 'required_all')`,
    ),
    check(
      "connections_session_limits_check",
      sql`("max_session_seconds" is null or "max_session_seconds" >= 300) and ("idle_timeout_seconds" is null or "idle_timeout_seconds" >= 300)`,
    ),
    pgPolicy("connections_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
    // ⚠ A SIGN-IN STARTS FROM A CONNECTION ID AND NO WORKSPACE (the gate's
    // start URL). Reading that one row tells the bridge its tenant.
    pgPolicy("connections_start_read", {
      for: "select",
      using: sql`${t.id}::text = nullif(current_setting('app.connection_id', true), '')`,
    }),
  ],
)

/**
 * The access domains (#326) a connection covers.
 *
 * ⚠ A FOREIGN KEY TO THE PROOF ITSELF, `core.join_domains`, AND THAT IS WHAT
 * MAKES DISPLACEMENT DISABLE SSO. A domain is live for a connection only while
 * its proof is verified, not lapsed and not displaced (`displaced_at`: another
 * workspace proved it later and latest proof wins). The bridge reads those
 * columns at every sign-in, so the moment the proof moves, nobody at that
 * domain is signed in or claimed through this connection - and a deleted proof
 * takes the row with it (cascade).
 *
 * ⚠ ONE CONNECTION PER PROOF. Two connections covering one domain would make
 * "which IdP does this address use" a coin toss.
 */
export const connectionDomains = identity.table(
  "connection_domains",
  {
    connectionId: uuid("connection_id").notNull(),
    joinDomainId: uuid("join_domain_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "connection_domains_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connections.id, connections.tenantId],
    }).onDelete("cascade"),
    foreignKey({
      name: "connection_domains_proof_fk",
      columns: [t.joinDomainId, t.tenantId],
      foreignColumns: [joinDomains.id, joinDomains.tenantId],
    }).onDelete("cascade"),
    primaryKey({ columns: [t.connectionId, t.joinDomainId] }),
    uniqueIndex("connection_domains_proof_unique").on(t.joinDomainId),
    pgPolicy("connection_domains_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * `(connection, subject)` -> Clerk user. The only identifier after first link.
 *
 * ⚠ NEVER MATCHED BY EMAIL. The address is recorded for the console; a later
 * sign-in finds the person by the IdP's subject alone, so an IdP that renames
 * somebody, or recycles an address, cannot move an account to someone else.
 */
export const identities = identity.table(
  "identities",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    subject: text("subject").notNull(),
    clerkUserId: text("clerk_user_id").notNull(),
    /** Lowercased, as last asserted. Shown, never matched. */
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "identities_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connections.id, connections.tenantId],
    }).onDelete("cascade"),
    uniqueIndex("identities_connection_subject_unique").on(t.connectionId, t.subject),
    uniqueIndex("identities_connection_user_unique").on(t.connectionId, t.clerkUserId),
    index("identities_user_idx").on(t.clerkUserId),
    pgPolicy("identities_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * One sign-in through the bridge, from the redirect to the bound session.
 *
 * ⚠ EVERY SECRET HERE IS A HASH, AND EACH IS SPENT ONCE. The browser holds the
 * binding cookie, the handoff code and the handoff secret; we hold their
 * SHA-256 (`binding_hash`, `handoff_code_hash`, `handoff_secret_hash`) and
 * stamp `consumed_at`, `redeemed_at` and `bound_at` with a compare-and-set, so
 * a second use of any of them finds the stamp and is refused. The PKCE
 * verifier is the only value the engine needs back in clear, so it is sealed.
 *
 * ⚠ THE SIGN-IN TOKEN ITSELF IS NEVER STORED. It is minted when the browser
 * redeems the handoff code and handed straight over; only its id is kept, for
 * the bind's check that Clerk accepted it.
 *
 * ⚠ THREE OUTSIDER POLICIES, ONE PER SECRET, READ ONLY. A browser arriving
 * with a handoff code knows no workspace; the policy lets that code's hash
 * read exactly its own row, and the write that follows is under that row's
 * tenant.
 */
export const loginAttempts = identity.table(
  "login_attempts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    /** `sign_in`, `test_run` or `step_up`. */
    purpose: text("purpose").notNull(),
    /** OIDC `state` / our correlation id, hashed. */
    stateHash: text("state_hash").notNull(),
    nonce: text("nonce"),
    /** Sealed. */
    pkceVerifier: text("pkce_verifier"),
    /** SAML AuthnRequest id, for InResponseTo. */
    requestId: text("request_id"),
    /** Where the browser goes when it is done; a path on our own origins. */
    returnTo: text("return_to"),
    /** SHA-256 of the browser-binding cookie. */
    bindingHash: text("binding_hash").notNull(),
    /** For `step_up`: the Clerk session being made fresh. */
    stepUpSessionId: text("step_up_session_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /** `signed_in`, `refused`, `tested`, `stepped_up`. */
    outcome: text("outcome"),
    failureReason: text("failure_reason"),
    clerkUserId: text("clerk_user_id"),
    identityId: uuid("identity_id"),
    clerkOrgId: text("clerk_org_id"),
    idpSession: text("idp_session"),
    authTime: timestamp("auth_time", { withTimezone: true }),
    handoffCodeHash: text("handoff_code_hash"),
    handoffExpiresAt: timestamp("handoff_expires_at", { withTimezone: true }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    signInTokenId: text("sign_in_token_id"),
    tokenMintedAt: timestamp("token_minted_at", { withTimezone: true }),
    handoffSecretHash: text("handoff_secret_hash"),
    boundAt: timestamp("bound_at", { withTimezone: true }),
    boundSessionId: text("bound_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "login_attempts_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connections.id, connections.tenantId],
    }).onDelete("cascade"),
    uniqueIndex("login_attempts_state_unique").on(t.stateHash),
    uniqueIndex("login_attempts_handoff_code_unique").on(t.handoffCodeHash),
    uniqueIndex("login_attempts_handoff_secret_unique").on(t.handoffSecretHash),
    index("login_attempts_tenant_idx").on(t.tenantId, t.createdAt),
    check(
      "login_attempts_purpose_check",
      sql`"purpose" in ('sign_in', 'test_run', 'step_up')`,
    ),
    pgPolicy("login_attempts_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
    pgPolicy("login_attempts_state_read", {
      for: "select",
      using: sql`${t.stateHash} = nullif(current_setting('app.attempt_state', true), '')`,
    }),
    pgPolicy("login_attempts_handoff_read", {
      for: "select",
      using: sql`${t.handoffCodeHash} = nullif(current_setting('app.handoff_code', true), '')`,
    }),
    pgPolicy("login_attempts_bind_read", {
      for: "select",
      using: sql`${t.handoffSecretHash} = nullif(current_setting('app.handoff_secret', true), '')`,
    }),
  ],
)

/** A test run: a real IdP sign-in on a `testing` connection, nobody signed in. */
export const testRuns = identity.table(
  "test_runs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    attemptId: uuid("attempt_id"),
    /** `passed` or `failed`. */
    outcome: text("outcome").notNull(),
    reason: text("reason"),
    /** The verified assertion as the engine returned it. */
    claims: jsonb("claims").$type<Record<string, unknown>>().notNull().default({}),
    /** What a real sign-in would have done. */
    resolution: jsonb("resolution")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "test_runs_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connections.id, connections.tenantId],
    }).onDelete("cascade"),
    index("test_runs_connection_idx").on(t.connectionId, t.createdAt),
    pgPolicy("test_runs_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * A Clerk session the bridge made: what the gate requires for a managed
 * account (sso.md 2.2).
 *
 * ⚠ KEYED ON CLERK'S `sid`, AND ONE ROW IS WRITTEN ONLY BY `POST /sso/bind`
 * after Clerk confirmed the ticket was accepted by THIS session. A session
 * that skipped the IdP has no row, and the gate refuses it.
 *
 * ⚠ `last_seen_at` IS WRITTEN AT MOST ONCE A MINUTE PER SESSION (the gate
 * throttles it), so the idle timeout is accurate to a minute, not a request.
 *
 * ⚠ `sso_sessions_user_read`: the gate knows only the signed-in user, so it
 * may read that user's rows in every workspace - their own, nobody else's.
 */
export const ssoSessions = identity.table(
  "sso_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    identityId: uuid("identity_id"),
    idpSession: text("idp_session"),
    authTime: timestamp("auth_time", { withTimezone: true }),
    boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
    /** The last IdP authentication: the sign-in, or a step-up since. */
    freshAt: timestamp("fresh_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    foreignKey({
      name: "sso_sessions_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connections.id, connections.tenantId],
    }).onDelete("cascade"),
    index("sso_sessions_user_idx").on(t.clerkUserId),
    index("sso_sessions_tenant_user_idx").on(t.tenantId, t.clerkUserId),
    index("sso_sessions_idp_session_idx").on(t.connectionId, t.idpSession),
    pgPolicy("sso_sessions_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
    pgPolicy("sso_sessions_user_read", {
      for: "select",
      using: sql`${t.clerkUserId} = nullif(current_setting('app.user_id', true), '')`,
    }),
  ],
)

/**
 * A Clerk user a workspace controls (sso.md 2.3): signs in only through that
 * workspace's IdP, cannot change email, cannot delete itself.
 *
 * ⚠ ONE WORKSPACE PER PERSON, BY PRIMARY KEY. Two IdPs disagreeing about one
 * person has no right answer, so the second claim is refused instead.
 *
 * ⚠ `emails` IS WHAT THE GATEWAY ASKS ABOUT. A sign-in names an identifier,
 * not a user; the addresses the account had when it was linked (and the
 * watchdog keeps it at) are the identifiers that must be told "use your
 * company's SSO". `managed_accounts_identifier_read` lets exactly a matching
 * row be read with no workspace in scope.
 */
export const managedAccounts = identity.table(
  "managed_accounts",
  {
    clerkUserId: text("clerk_user_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => connections.id, {
      onDelete: "set null",
    }),
    /** `scim`, `jit`, `claimed` (existing account, verified domain) or `linked`. */
    reason: text("reason").notNull(),
    /** Lowercased verified addresses the account may keep. */
    emails: text("emails")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("managed_accounts_tenant_idx").on(t.tenantId),
    index("managed_accounts_emails_idx").using("gin", t.emails),
    check(
      "managed_accounts_reason_check",
      sql`"reason" in ('scim', 'jit', 'claimed', 'linked')`,
    ),
    pgPolicy("managed_accounts_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
    pgPolicy("managed_accounts_user_read", {
      for: "select",
      using: sql`${t.clerkUserId} = nullif(current_setting('app.user_id', true), '')`,
    }),
    pgPolicy("managed_accounts_identifier_read", {
      for: "select",
      using: sql`nullif(current_setting('app.identifier', true), '') = any(${t.emails})`,
    }),
  ],
)

/** Break-glass: people a connection lets sign in another way (#340 uses it). */
export const bypassUsers = identity.table(
  "bypass_users",
  {
    connectionId: uuid("connection_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    reason: text("reason"),
    addedBy: text("added_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "bypass_users_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connections.id, connections.tenantId],
    }).onDelete("cascade"),
    primaryKey({ columns: [t.connectionId, t.clerkUserId] }),
    pgPolicy("bypass_users_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/** Setup links for a customer's IT contact (#340): hashed, scoped, revocable. */
export const setupLinks = identity.table(
  "setup_links",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id"),
    tokenHash: text("token_hash").notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    contactEmail: text("contact_email"),
    createdBy: text("created_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "setup_links_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connections.id, connections.tenantId],
    }).onDelete("cascade"),
    uniqueIndex("setup_links_token_unique").on(t.tokenHash),
    index("setup_links_tenant_idx").on(t.tenantId),
    pgPolicy("setup_links_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * The identity audit log: sign-ins, failures with their reason, setup
 * changes, revocations.
 *
 * ⚠ NO FOREIGN KEYS BUT THE TENANT. An event about a connection or a session
 * must outlive both; only the workspace going takes its log with it.
 *
 * ⚠ NOTHING SECRET, EVER: no token, code, ticket, cookie or assertion body.
 * `data` carries ids, reasons and what was decided.
 */
export const events = identity.table(
  "events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actorUserId: text("actor_user_id"),
    subjectUserId: text("subject_user_id"),
    connectionId: uuid("connection_id"),
    sessionId: text("session_id"),
    reason: text("reason"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("events_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("events_subject_idx").on(t.tenantId, t.subjectUserId),
    // ⚠ APPEND ONLY: a read policy and an insert policy, and none for update
    // or delete, so no request - whoever's - can rewrite or erase the log.
    // Only the workspace going takes it (the cascade, which RLS does not see).
    pgPolicy("events_workspace", {
      for: "select",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
    pgPolicy("events_workspace_insert", {
      for: "insert",
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * Per-workspace identity settings (decision 5): what deprovisioning does.
 * No row means the default, `membership`.
 */
export const workspaceSettings = identity.table(
  "workspace_settings",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** `membership` (remove from this workspace) or `account` (ban everywhere). */
    deprovision: text("deprovision").notNull().default("membership"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "workspace_settings_deprovision_check",
      sql`"deprovision" in ('membership', 'account')`,
    ),
    pgPolicy("workspace_settings_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)
