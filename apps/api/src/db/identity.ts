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
 * hand-made part (migration 0140, `drizzle-kit generate --custom`): Drizzle
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
    /**
     * When a sign-in on this connection last carried `groupsState: "present"`.
     * Once set, an `absent` group claim is read as an empty list (Okta omits
     * `groups` when nobody matches its filter); while null, `absent` keeps
     * existing roles (Google OIDC, an unmapped attribute, a missing scope).
     */
    groupsLastSeenAt: timestamp("groups_last_seen_at", { withTimezone: true }),
    /**
     * What a changed IdP subject does (sso.md 2.22): `ask` refuses the sign-in
     * and files a request an owner approves; `auto` moves the link when the
     * verified address matches. ⚠ `auto` IS TRUST, so an owner's to set.
     */
    relink: text("relink").notNull().default("ask"),
    /**
     * Entra only: the user principal name stands in for the email when the
     * IdP sends none (a member whose `mail` is empty). Off unless an owner
     * turns it on; the bridge still needs the UPN's domain to be proved.
     */
    upnAsEmail: boolean("upn_as_email").notNull().default(false),
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
    check("connections_relink_check", sql`"relink" in ('ask', 'auto')`),
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
 * A SAML connection's IdP signing certificates (#339, sso.md 2.3): several at
 * once, so an IdP can rotate by publishing the next one before it signs with
 * it.
 *
 * ⚠ PUBLIC CERTIFICATES, NOT SECRETS, BUT TRUST ALL THE SAME. Whatever is in
 * this table can sign somebody into the workspace, so on an active or
 * disabled connection only an owner adds or removes a row
 * (routes/console/identity-saml.ts). `source` says who put it there: an
 * admin's upload, or the metadata URL, whose daily refresh replaces only its
 * own rows.
 *
 * ⚠ `alerted_days` IS THE SMALLEST EXPIRY THRESHOLD (30, 7, 1) ALREADY
 * ANNOUNCED, so the daily pass alerts once per threshold, not once per day.
 */
export const samlCertificates = identity.table(
  "saml_certificates",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    /** SHA-256 of the DER, lowercase hex. */
    fingerprint: text("fingerprint").notNull(),
    /** The DER, base64. */
    certificate: text("certificate").notNull(),
    subject: text("subject").notNull(),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    alertedDays: integer("alerted_days"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "saml_certificates_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connections.id, connections.tenantId],
    }).onDelete("cascade"),
    uniqueIndex("saml_certificates_connection_fingerprint_unique").on(
      t.connectionId,
      t.fingerprint,
    ),
    index("saml_certificates_not_after_idx").on(t.notAfter),
    check("saml_certificates_source_check", sql`"source" in ('upload', 'metadata')`),
    pgPolicy("saml_certificates_workspace", {
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
 * A person's IdP sent a new subject and an owner has not approved it yet
 * (sso.md 2.22): the minimum needed to move the link when they do.
 *
 * ⚠ ONE PENDING REQUEST PER IDENTITY, BY UNIQUE INDEX, so a person retrying
 * a refused sign-in files nothing new. The new subject is kept in the clear
 * (it is what the link becomes); the address only as a hash, and the audit log
 * never carries either. Deleting the identity takes its request with it.
 */
export const relinkRequests = identity.table(
  "relink_requests",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    newSubject: text("new_subject").notNull(),
    /** SHA-256 of the normalised address the IdP asserted. */
    emailHash: text("email_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: "relink_requests_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connections.id, connections.tenantId],
    }).onDelete("cascade"),
    uniqueIndex("relink_requests_identity_unique").on(t.identityId),
    index("relink_requests_connection_idx").on(t.connectionId, t.createdAt),
    pgPolicy("relink_requests_workspace", {
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
    /** For `sign_in`: the address typed on our sign-in page, lowercased. */
    loginHint: text("login_hint"),
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

/**
 * Group-to-role rules (#341, sso.md 2.3 and 2.6): which of OUR roles (#335) a
 * group the IdP names gives, per connection, first match by precedence.
 *
 * ⚠ NEVER OWNER, IN THE DATABASE ITSELF. A rule is matched against whatever
 * groups the IdP sends, and ownership is only ever handed on by an owner; the
 * check below means no code path, however wrong, can store a rule that makes
 * somebody an owner. Admin is allowed - an admin can make admins anyway - and
 * changing rules on a live connection is an owner's (routes/console/
 * identity-groups.ts).
 *
 * ⚠ `group_value` IS COMPARED EXACTLY, as the IdP sends it (Okta a name,
 * Entra an object id). One rule per group per connection.
 */
export const groupRoleRules = identity.table(
  "group_role_rules",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    groupValue: text("group_value").notNull(),
    /** `member` or `admin`: a joining role (console/roles.ts `JOIN_ROLES`). */
    role: text("role").notNull(),
    /** Lower first; equal precedence falls to the older rule. */
    precedence: integer("precedence").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "group_role_rules_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connections.id, connections.tenantId],
    }).onDelete("cascade"),
    uniqueIndex("group_role_rules_connection_group_unique").on(
      t.connectionId,
      t.groupValue,
    ),
    index("group_role_rules_connection_idx").on(t.connectionId, t.precedence),
    check("group_role_rules_role_check", sql`"role" in ('member', 'admin')`),
    check(
      "group_role_rules_precedence_check",
      sql`"precedence" >= 0 and "precedence" <= 10000`,
    ),
    pgPolicy("group_role_rules_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
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

/**
 * Bypass sign-ins (#340, decision 7): a session of somebody on a connection's
 * bypass list that the gate let through without SSO.
 *
 * ⚠ ONE ROW PER WORKSPACE AND SESSION, BY PRIMARY KEY, and that is what makes
 * `sso.bypass_used` once per session across every API process: the gate's
 * insert and the audit row share one transaction, and only the insert that
 * made the row writes the event.
 */
export const bypassSignIns = identity.table(
  "bypass_sign_ins",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    clerkUserId: text("clerk_user_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "bypass_sign_ins_connection_fk",
      columns: [t.connectionId, t.tenantId],
      foreignColumns: [connections.id, connections.tenantId],
    }).onDelete("cascade"),
    primaryKey({ columns: [t.tenantId, t.sessionId] }),
    pgPolicy("bypass_sign_ins_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * Setup links for a customer's IT contact (#340): hashed, scoped, revocable.
 *
 * ⚠ ONE CONNECTION, AND ONLY WHILE IT IS `draft` OR `testing`. The routes
 * (routes/sso-setup.ts) read the connection at every request; activating it
 * revokes its links as well, so an owner moving it back to setup later does
 * not bring an old link back to life.
 *
 * ⚠ `setup_links_hash_read`: a setup request knows no workspace, only the
 * token in its URL. The hash of that token reads exactly its own row, as a
 * SCIM token does in `directory_tokens`.
 */
export const setupLinks = identity.table(
  "setup_links",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
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
    pgPolicy("setup_links_hash_read", {
      for: "select",
      using: sql`${t.tokenHash} = nullif(current_setting('app.setup_token', true), '')`,
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
    // ⚠ CONNECTION HEALTH (#345, identity/health.ts): "failures of this
    // connection in the last day" and "its last success" are both a range
    // read on (connection, type, time), newest first.
    index("events_connection_type_idx").on(
      t.tenantId,
      t.connectionId,
      t.type,
      t.createdAt.desc(),
    ),
    // ⚠ THE SIEM EXPORT'S CURSOR (#345): events after an id, in id order. Ids
    // are UUIDv7, so id order is time order, and unlike `created_at` it is
    // unique, so a cursor can never skip or repeat a row written in the same
    // microsecond.
    index("events_tenant_id_idx").on(t.tenantId, t.id),
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
 * Where a workspace's identity audit log is exported to (#345): its own
 * S3-compatible bucket, hourly. One row per workspace.
 *
 * ⚠ THE SECRET ACCESS KEY IS SEALED WITH THE WEBHOOK SECRET BOX
 * (`secret_ciphertext`, the box that keeps webhook signing secrets and the
 * SQS endpoint keys), never stored plain and never returned by any read: the
 * console sees `secret_hint` (its last four characters) and nothing else. The
 * key should belong to a user that can do nothing but `s3:PutObject` under the
 * prefix; the docs say so and we cannot check it.
 *
 * ⚠ THE CURSOR IS THE LAST EVENT ID WRITTEN TO THE BUCKET, advanced only after
 * the PUT succeeded, so a failed run exports the same events again rather than
 * skipping them. Event ids are UUIDv7: id order is time order and unique.
 *
 * ⚠ `next_run_at` IS THE SCHEDULE'S RECORD AND THE LEASE: a run claims the row
 * by moving it forward, so two replicas never export the same window, and a
 * run that died is retried when its lease lapses.
 */
export const siemExports = identity.table(
  "siem_exports",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** https only, vetted by the webhook egress guard on write and on every run. */
    endpoint: text("endpoint").notNull(),
    bucket: text("bucket").notNull(),
    region: text("region").notNull(),
    /** Under the bucket; no leading or trailing slash. May be empty. */
    prefix: text("prefix").notNull().default(""),
    accessKeyId: text("access_key_id").notNull(),
    /** Sealed. See above. */
    secretCiphertext: text("secret_ciphertext").notNull(),
    /** The last four characters of the secret, for the console to recognise it by. */
    secretHint: text("secret_hint").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** The last event written to the bucket; null: nothing exported yet. */
    lastEventId: uuid("last_event_id"),
    lastExportAt: timestamp("last_export_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    pgPolicy("siem_exports_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * Per-workspace identity settings: what deprovisioning does (decision 5), and
 * the owner exemption (decision 7, #340). No row means the defaults,
 * `membership` and exempt.
 *
 * ⚠ TURNING THE EXEMPTION OFF TAKES TWO OWNERS. The first one's request is
 * `exemption_off_requested_by` / `_at`; a different owner's approval within a
 * day applies it, as one compare-and-set on these columns. Turning it back on
 * is one owner's, and clears any request.
 */
export const workspaceSettings = identity.table(
  "workspace_settings",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** `membership` (remove from this workspace) or `account` (ban everywhere). */
    deprovision: text("deprovision").notNull().default("membership"),
    /** Unmanaged owners and admins are exempt from "required" SSO, and must hold a passkey. */
    ownerExemption: boolean("owner_exemption").notNull().default(true),
    /**
     * What happens to a deprovisioned person's mailbox after it is suspended
     * (#344): `keep` (suspended until reactivated), `forward_manager`, or
     * `delete_after` (`leaver_days`, 7 to 365). A per-mailbox choice, which can
     * also name a delegate, overrides it.
     */
    leaverAction: text("leaver_action").notNull().default("keep"),
    leaverDays: integer("leaver_days"),
    /** The owner who asked to turn the exemption off, until another owner approves. */
    exemptionOffRequestedBy: text("exemption_off_requested_by"),
    exemptionOffRequestedAt: timestamp("exemption_off_requested_at", {
      withTimezone: true,
    }),
    /**
     * The workspace's session policy (#345): every session in it, SSO or not,
     * is refused past these. Null is "no limit". The bounds are the route's
     * as well; the database is the net under it.
     */
    maxSessionSeconds: integer("max_session_seconds"),
    idleTimeoutSeconds: integer("idle_timeout_seconds"),
    /** Members outside SSO need a second factor at Clerk to reach the workspace. */
    requireSecondFactor: boolean("require_second_factor").notNull().default(false),
    /** The IP allowlist's two switches, and its ranges (canonical CIDR text, at most 100). */
    ipAllowlistConsole: boolean("ip_allowlist_console").notNull().default(false),
    ipAllowlistApiKeys: boolean("ip_allowlist_api_keys").notNull().default(false),
    ipRanges: text("ip_ranges")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * The owner who saved a console allowlist that left their own address out
     * (after confirming), and that address: allowed for them alone until
     * `ip_grace_until`, so saving a list never ends the saving session.
     */
    ipGraceUserId: text("ip_grace_user_id"),
    ipGraceAddress: text("ip_grace_address"),
    ipGraceUntil: timestamp("ip_grace_until", { withTimezone: true }),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "workspace_settings_deprovision_check",
      sql`"deprovision" in ('membership', 'account')`,
    ),
    check(
      "workspace_settings_leaver_check",
      sql`"leaver_action" in ('keep', 'forward_manager', 'delete_after') and (("leaver_action" = 'delete_after') = ("leaver_days" is not null)) and ("leaver_days" is null or "leaver_days" between 7 and 365)`,
    ),
    check(
      "workspace_settings_exemption_request_check",
      sql`("exemption_off_requested_by" is null) = ("exemption_off_requested_at" is null)`,
    ),
    check(
      "workspace_settings_session_bounds_check",
      sql`("max_session_seconds" is null or "max_session_seconds" between 900 and 7776000)
        and ("idle_timeout_seconds" is null or "idle_timeout_seconds" between 300 and 2592000)`,
    ),
    check("workspace_settings_ip_ranges_check", sql`cardinality("ip_ranges") <= 100`),
    check(
      "workspace_settings_ip_grace_check",
      sql`("ip_grace_user_id" is null) = ("ip_grace_address" is null)
        and ("ip_grace_user_id" is null) = ("ip_grace_until" is null)`,
    ),
    pgPolicy("workspace_settings_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * When a session of a workspace that has a session policy (#345) started and
 * was last used.
 *
 * ⚠ ONLY FOR SESSIONS NO SSO BIND TRACKS. A bound session is measured from
 * `sso_sessions` (its bind and its `last_seen_at`, which the managed gate
 * keeps); every other session in a workspace with limits gets a row here on
 * first sight. `started_at` is CLERK'S creation time for the session, so the
 * maximum length is the session's real age, not the age of our first look.
 *
 * ⚠ `last_seen_at` IS WRITTEN AT MOST ONCE A MINUTE PER SESSION, like the
 * gate's, so the idle timeout is accurate to a minute (and may not be set
 * below five).
 */
export const sessionActivity = identity.table(
  "session_activity",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    clerkUserId: text("clerk_user_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.sessionId] }),
    index("session_activity_seen_idx").on(t.tenantId, t.lastSeenAt),
    pgPolicy("session_activity_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

// ── SCIM directories (#342, sso.md 2.3 and 2.7) ─────────────────────────────

/**
 * A company directory that provisions people into a workspace over SCIM 2.0:
 * its base URL is `<SCIM_BASE_URL>/<id>`, its credentials are rows of
 * `directory_tokens`.
 *
 * ⚠ ONE PER IdP APP, PER WORKSPACE, AND NOT TIED TO A CONNECTION. Okta and
 * Entra provision through an app of their own that need not be the SSO app,
 * Google's directory (#343) has no connection at all, a connection can be
 * rebuilt (OIDC to SAML) without provisioning everybody again, and "active
 * while any enabled directory says active" (sso.md 2.7) needs several per
 * workspace. A person a directory provisions signs in through whichever of the
 * workspace's connections covers their address (`directoryPreProvisioned`).
 *
 * ⚠ `enabled: false` STOPS THE DIRECTORY, IT DOES NOT DEPROVISION ANYBODY.
 * Its tokens stop working and its "active" no longer keeps anybody in;
 * nothing is taken away until a directory that is still enabled says so.
 */
export const directories = identity.table(
  "directories",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** `okta`, `entra`, `google`, `generic`: which setup guide (#340) applies. */
    provider: text("provider").notNull().default("generic"),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Give the people this directory activates a mailbox on the workspace's
     * hosted domains (#344, sso.md 2.8). Off by default; turning it ON is an
     * owner's with step-up, because it makes the directory's admin able to
     * create addresses that receive the workspace's mail.
     */
    createMailboxes: boolean("create_mailboxes").notNull().default(false),
    /** Customer Workspace admin to act as for domain-wide delegation (#343). */
    adminEmail: text("admin_email"),
    /** Primary Workspace domain pulled for a `google` directory (#343). */
    domain: text("domain"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    /** `ok` or `failed` after a Google pull; null before the first run. */
    lastSyncStatus: text("last_sync_status"),
    /** Fixed error code when `lastSyncStatus` is `failed`; never Google's message. */
    lastSyncError: text("last_sync_error"),
    /**
     * An owner's one-shot go-ahead for a Google pull the shrink guard refused
     * (`large_drop`): the most people one pull may remove. Set only with
     * `allowDropAt`; any pull that gets past the guard clears both, and it is
     * ignored after 24 hours. Null when none is given.
     */
    allowDropUpTo: integer("allow_drop_up_to"),
    allowDropAt: timestamp("allow_drop_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("directories_tenant_idx").on(t.tenantId),
    unique("directories_id_tenant_unique").on(t.id, t.tenantId),
    check(
      "directories_provider_check",
      sql`"provider" in ('okta', 'entra', 'google', 'generic')`,
    ),
    check(
      "directories_last_sync_status_check",
      sql`"last_sync_status" is null or "last_sync_status" in ('ok', 'failed')`,
    ),
    check(
      "directories_allow_drop_check",
      sql`("allow_drop_up_to" is null and "allow_drop_at" is null) or ("allow_drop_up_to" >= 0 and "allow_drop_at" is not null)`,
    ),
    pgPolicy("directories_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * A directory's bearer tokens.
 *
 * ⚠ ONLY THE SHA-256 OF A TOKEN IS EVER STORED, and the token itself is shown
 * once, when it is made. A SCIM token can create and deprovision accounts.
 *
 * ⚠ ROTATION OVERLAPS. A new token gives every older live one an `expires_at`
 * (the overlap the owner chose, zero for at once), so the IdP can be switched
 * over without a window of failed pushes; `revoked_at` ends one at once.
 *
 * ⚠ `directory_tokens_hash_read`: a SCIM request knows no workspace, only the
 * token it presents. The hash of that token reads exactly its own row, as a
 * handoff code does in `login_attempts`, and the request is then served under
 * the tenant that row names.
 */
export const directoryTokens = identity.table(
  "directory_tokens",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    directoryId: uuid("directory_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** The first characters of the token, so the console can tell them apart. */
    hint: text("hint").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Written at most once a minute per token. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "directory_tokens_directory_fk",
      columns: [t.directoryId, t.tenantId],
      foreignColumns: [directories.id, directories.tenantId],
    }).onDelete("cascade"),
    uniqueIndex("directory_tokens_hash_unique").on(t.tokenHash),
    index("directory_tokens_directory_idx").on(t.directoryId),
    pgPolicy("directory_tokens_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
    pgPolicy("directory_tokens_hash_read", {
      for: "select",
      using: sql`${t.tokenHash} = nullif(current_setting('app.scim_token', true), '')`,
    }),
  ],
)

/**
 * A person as a directory sent them: the SCIM User resource, and what we made
 * of it.
 *
 * ⚠ `resource` IS THE WHOLE RESOURCE AS STORED (core attributes, the
 * enterprise extension, custom extension attributes), minus `id`, `meta`,
 * `groups` and never a password. The columns beside it are what the API
 * matches and filters on, re-read from `resource` on every write so the two
 * cannot drift.
 *
 * ⚠ `clerk_user_id` IS WRITTEN BY THE APPLY JOB, NEVER BY A SCIM REQUEST. A
 * directory decides who should exist; whether a Clerk account is made, claimed
 * or refused is ours (identity/directory.ts), and why not is `conflict`.
 *
 * ⚠ A DELETE MARKS `deleted_at`; THE ROW GOES ONCE THE APPLY JOB HAS
 * DEPROVISIONED THE PERSON. It is how the job still knows whose account it
 * was. To SCIM the row is gone at once, and its userName is free again.
 */
export const directoryUsers = identity.table(
  "directory_users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    directoryId: uuid("directory_id").notNull(),
    userName: text("user_name").notNull(),
    externalId: text("external_id"),
    displayName: text("display_name"),
    givenName: text("given_name"),
    familyName: text("family_name"),
    /** The primary address, lowercased, or null when the resource has none. */
    email: text("email"),
    active: boolean("active").notNull().default(true),
    resource: jsonb("resource").$type<Record<string, unknown>>().notNull().default({}),
    clerkUserId: text("clerk_user_id"),
    /** Why the person is not (fully) in: see `DIRECTORY_CONFLICTS`. */
    conflict: text("conflict"),
    conflictDetail: jsonb("conflict_detail").$type<Record<string, unknown>>(),
    conflictAt: timestamp("conflict_at", { withTimezone: true }),
    /**
     * Deprovisioning in `account` mode banned the Clerk user, so reactivation
     * may lift that ban. A ban without this is somebody else's, and wins.
     */
    bannedByDirectory: boolean("banned_by_directory").notNull().default(false),
    /**
     * Directory addresses (`emails[]`) beyond the primary that were NOT made
     * aliases because they are off the workspace's hosted domains or taken
     * (#344). Counted here, not stored.
     */
    aliasesIgnored: integer("aliases_ignored").notNull().default(0),
    /**
     * Why this person has no mailbox though the directory asks for them
     * (`domain_not_hosted`, `limit`, `address_taken`), audited when it changes.
     */
    mailboxNote: text("mailbox_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "directory_users_directory_fk",
      columns: [t.directoryId, t.tenantId],
      foreignColumns: [directories.id, directories.tenantId],
    }).onDelete("cascade"),
    unique("directory_users_id_tenant_unique").on(t.id, t.tenantId),
    unique("directory_users_id_directory_tenant_unique").on(
      t.id,
      t.directoryId,
      t.tenantId,
    ),
    // ⚠ CASE-INSENSITIVE, AS SCIM's userName IS (RFC 7643 4.1.1), and free
    // again the moment the row is deleted.
    uniqueIndex("directory_users_user_name_unique")
      .on(t.directoryId, sql`lower(${t.userName})`)
      .where(sql`${t.deletedAt} is null`),
    // One row per person per directory: a second would be a second identity.
    uniqueIndex("directory_users_clerk_user_unique")
      .on(t.directoryId, t.clerkUserId)
      .where(sql`${t.deletedAt} is null and ${t.clerkUserId} is not null`),
    index("directory_users_tenant_user_idx").on(t.tenantId, t.clerkUserId),
    index("directory_users_external_idx").on(t.directoryId, t.externalId),
    index("directory_users_email_idx").on(t.tenantId, t.email),
    check(
      "directory_users_mailbox_note_check",
      sql`"mailbox_note" is null or "mailbox_note" in ('domain_not_hosted', 'limit', 'address_taken')`,
    ),
    check(
      "directory_users_conflict_check",
      sql`"conflict" is null or "conflict" in ('workspace_full', 'blocked', 'banned', 'domain_not_verified', 'address_taken', 'ambiguous_account', 'managed_elsewhere', 'role_exempt', 'already_linked', 'no_email', 'profile_incomplete', 'last_owner', 'account_deleted', 'no_sso_connection')`,
    ),
    pgPolicy("directory_users_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/** A group as a directory sent it. Its members are `directory_memberships`. */
export const directoryGroups = identity.table(
  "directory_groups",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    directoryId: uuid("directory_id").notNull(),
    displayName: text("display_name").notNull(),
    externalId: text("external_id"),
    /** The resource minus `id`, `meta` and `members`. */
    resource: jsonb("resource").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * The list address an admin gave this group (#344), on a domain the
     * workspace hosts mail for; null: not a mailing list. Set and cleared only
     * by the admin's opt-in route, never by a directory.
     */
    mailAddress: text("mail_address"),
    /** `list` (members each get a copy) or `shared` (members share the box). */
    mailKind: text("mail_kind"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "directory_groups_mail_check",
      sql`("mail_address" is null) = ("mail_kind" is null) and ("mail_kind" is null or "mail_kind" in ('list', 'shared'))`,
    ),
    uniqueIndex("directory_groups_mail_address_unique")
      .on(sql`lower(${t.mailAddress})`)
      .where(sql`${t.mailAddress} is not null`),
    // ⚠ ONE NAME PER DIRECTORY, CASE-INSENSITIVELY, AS SCIM's displayName IS
    // (RFC 7643 4.2): a duplicate is a 409, not a second group.
    uniqueIndex("directory_groups_display_name_unique").on(
      t.directoryId,
      sql`lower(${t.displayName})`,
    ),
    foreignKey({
      name: "directory_groups_directory_fk",
      columns: [t.directoryId, t.tenantId],
      foreignColumns: [directories.id, directories.tenantId],
    }).onDelete("cascade"),
    unique("directory_groups_id_tenant_unique").on(t.id, t.tenantId),
    unique("directory_groups_id_directory_tenant_unique").on(
      t.id,
      t.directoryId,
      t.tenantId,
    ),
    index("directory_groups_directory_idx").on(t.directoryId, t.displayName),
    pgPolicy("directory_groups_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * Who is in which group.
 *
 * ⚠ BOTH SIDES CARRY THE DIRECTORY AND THE TENANT, as composite foreign keys
 * on `(id, directory_id, tenant_id)`: a group can only ever hold people of
 * its own directory, in its own workspace, whatever id a request names.
 */
export const directoryMemberships = identity.table(
  "directory_memberships",
  {
    groupId: uuid("group_id").notNull(),
    userId: uuid("user_id").notNull(),
    directoryId: uuid("directory_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "directory_memberships_group_fk",
      columns: [t.groupId, t.directoryId, t.tenantId],
      foreignColumns: [
        directoryGroups.id,
        directoryGroups.directoryId,
        directoryGroups.tenantId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "directory_memberships_user_fk",
      columns: [t.userId, t.directoryId, t.tenantId],
      foreignColumns: [
        directoryUsers.id,
        directoryUsers.directoryId,
        directoryUsers.tenantId,
      ],
    }).onDelete("cascade"),
    primaryKey({ columns: [t.groupId, t.userId] }),
    index("directory_memberships_user_idx").on(t.userId),
    pgPolicy("directory_memberships_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * The outbox: every SCIM change to a person, written in the SAME transaction
 * as the change, for the apply job to carry to Clerk, the membership and our
 * roles (sso.md 2.7). Clerk calls cannot sit inside a transaction; this is
 * what makes "the directory said so" survive a crash between the two.
 *
 * ⚠ AN ENTRY NAMES A PERSON, NOT WHAT TO DO TO THEM. The job reads the row as
 * it is NOW and brings Clerk to it, so entries can be applied late, twice or
 * out of order and the outcome is the same; it then stamps `applied_at` on
 * every entry it saw. A group change writes one entry per member it touched.
 */
export const directoryOutbox = identity.table(
  "directory_outbox",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    directoryId: uuid("directory_id").notNull(),
    directoryUserId: uuid("directory_user_id").notNull(),
    /** What changed, for the record: `created`, `updated`, `deleted`, `group`. */
    cause: text("cause").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    /** The last failure's short reason. Never a token or a payload. */
    lastError: text("last_error"),
  },
  (t) => [
    foreignKey({
      name: "directory_outbox_user_fk",
      columns: [t.directoryUserId, t.directoryId, t.tenantId],
      foreignColumns: [
        directoryUsers.id,
        directoryUsers.directoryId,
        directoryUsers.tenantId,
      ],
    }).onDelete("cascade"),
    index("directory_outbox_pending_idx")
      .on(t.tenantId, t.directoryId, t.createdAt)
      .where(sql`${t.appliedAt} is null`),
    index("directory_outbox_user_idx").on(t.directoryUserId),
    check(
      "directory_outbox_cause_check",
      sql`"cause" in ('created', 'updated', 'deleted', 'group')`,
    ),
    pgPolicy("directory_outbox_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)

/**
 * Push notification channels registered with Google's `users.watch` (#343).
 *
 * ⚠ ONLY THE SHA-256 OF `X-Goog-Channel-Token` IS STORED. A notification on
 * `POST /google/directory/notify` looks up the channel by `id` via
 * `directory_watch_channels_id_read`, compares the token hash in constant time,
 * audits a wrong token under the row's workspace, and schedules a pull without
 * trusting anything in the request body.
 */
export const directoryWatchChannels = identity.table(
  "directory_watch_channels",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    directoryId: uuid("directory_id").notNull(),
    /** Which `users.watch` event this channel listens for. */
    event: text("event").notNull(),
    /** Opaque server-side resource id Google needs on `channels.stop`. */
    resourceId: text("resource_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "directory_watch_channels_directory_fk",
      columns: [t.directoryId, t.tenantId],
      foreignColumns: [directories.id, directories.tenantId],
    }).onDelete("cascade"),
    index("directory_watch_channels_directory_idx").on(t.directoryId),
    check(
      "directory_watch_channels_event_check",
      sql`"event" in ('add', 'update', 'delete', 'undelete')`,
    ),
    pgPolicy("directory_watch_channels_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
    pgPolicy("directory_watch_channels_id_read", {
      for: "select",
      using: sql`${t.id}::text = nullif(current_setting('app.google_channel', true), '')`,
    }),
  ],
)

/**
 * A mailbox a workspace's directory gave or suspended (#344, sso.md 2.8): the
 * lifecycle that `authd.accounts` cannot hold, keyed by person.
 *
 * ⚠ THE MAIL ITSELF IS NOT HERE. The row says where the mailbox is in its life
 * and what the admin chose for it; whether it resolves, receives or accepts a
 * login is `authd.accounts` (`active`, `suspended_at`), written in the SAME
 * transaction by mailboxes/store.ts, so the two cannot disagree.
 *
 * ⚠ DELETION IS A DATE, NEVER AN EVENT. `delete_at` is set at suspension (or
 * when the admin picks "delete") as now + N days, N between 7 and 365, and the
 * check below keeps the pair together; nothing deletes a mailbox before it,
 * and the job re-checks that no enabled directory says the person is active.
 */
export const directoryMailboxes = identity.table(
  "directory_mailboxes",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    clerkUserId: text("clerk_user_id").notNull(),
    /** The primary address, lowercased, as the mailbox had it when suspended. */
    address: text("address").notNull(),
    /** `active` or `suspended`. A deleted mailbox has no row. */
    state: text("state").notNull().default("active"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    /** `keep`, `forward_manager`, `delegate` or `delete`: the admin's pick. */
    next: text("next").notNull().default("keep"),
    /** Who receives a copy (forward) or may open the mailbox (delegate). */
    targetUserId: text("target_user_id"),
    deleteAfterDays: integer("delete_after_days"),
    deleteAt: timestamp("delete_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.clerkUserId] }),
    index("directory_mailboxes_due_idx")
      .on(t.tenantId, t.deleteAt)
      .where(sql`${t.deleteAt} is not null`),
    check("directory_mailboxes_state_check", sql`"state" in ('active', 'suspended')`),
    check(
      "directory_mailboxes_next_check",
      sql`"next" in ('keep', 'forward_manager', 'delegate', 'delete')`,
    ),
    check(
      "directory_mailboxes_target_check",
      sql`(("next" in ('forward_manager', 'delegate')) = ("target_user_id" is not null))`,
    ),
    check(
      "directory_mailboxes_delete_check",
      sql`(("next" = 'delete') = ("delete_at" is not null)) and (("next" = 'delete') = ("delete_after_days" is not null)) and ("delete_after_days" is null or "delete_after_days" between 7 and 365)`,
    ),
    check(
      "directory_mailboxes_suspended_check",
      sql`("state" = 'suspended') = ("suspended_at" is not null) and ("state" = 'suspended' or "next" = 'keep')`,
    ),
    pgPolicy("directory_mailboxes_workspace", {
      for: "all",
      using: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
      withCheck: sql`${t.tenantId} = current_setting('app.tenant_id')::uuid`,
    }),
  ],
)
