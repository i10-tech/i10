CREATE SCHEMA "identity";
--> statement-breakpoint
CREATE TABLE "identity"."bypass_users" (
	"connection_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"reason" text,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bypass_users_connection_id_clerk_user_id_pk" PRIMARY KEY("connection_id","clerk_user_id")
);
--> statement-breakpoint
ALTER TABLE "identity"."bypass_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."connection_domains" (
	"connection_id" uuid NOT NULL,
	"join_domain_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_domains_connection_id_join_domain_id_pk" PRIMARY KEY("connection_id","join_domain_id")
);
--> statement-breakpoint
ALTER TABLE "identity"."connection_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"provider" text DEFAULT 'generic' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets" text,
	"enforcement" text DEFAULT 'off' NOT NULL,
	"jit_enabled" boolean DEFAULT false NOT NULL,
	"mfa_required" boolean DEFAULT false NOT NULL,
	"max_session_seconds" integer,
	"idle_timeout_seconds" integer,
	"attribute_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "connections_protocol_check" CHECK ("protocol" in ('oidc', 'saml', 'test')),
	CONSTRAINT "connections_status_check" CHECK ("status" in ('draft', 'testing', 'active', 'disabled')),
	CONSTRAINT "connections_enforcement_check" CHECK ("enforcement" in ('off', 'optional', 'required_domain', 'required_all')),
	CONSTRAINT "connections_session_limits_check" CHECK (("max_session_seconds" is null or "max_session_seconds" >= 300) and ("idle_timeout_seconds" is null or "idle_timeout_seconds" >= 300))
);
--> statement-breakpoint
ALTER TABLE "identity"."connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_user_id" text,
	"subject_user_id" text,
	"connection_id" uuid,
	"session_id" text,
	"reason" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."identities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"clerk_user_id" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "identity"."identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"state_hash" text NOT NULL,
	"nonce" text,
	"pkce_verifier" text,
	"request_id" text,
	"return_to" text,
	"binding_hash" text NOT NULL,
	"step_up_session_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"outcome" text,
	"failure_reason" text,
	"clerk_user_id" text,
	"identity_id" uuid,
	"clerk_org_id" text,
	"idp_session" text,
	"auth_time" timestamp with time zone,
	"handoff_code_hash" text,
	"handoff_expires_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"sign_in_token_id" text,
	"token_minted_at" timestamp with time zone,
	"handoff_secret_hash" text,
	"bound_at" timestamp with time zone,
	"bound_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_attempts_purpose_check" CHECK ("purpose" in ('sign_in', 'test_run', 'step_up'))
);
--> statement-breakpoint
ALTER TABLE "identity"."login_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."managed_accounts" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid,
	"reason" text NOT NULL,
	"emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_accounts_reason_check" CHECK ("reason" in ('scim', 'jit', 'claimed', 'linked'))
);
--> statement-breakpoint
ALTER TABLE "identity"."managed_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."setup_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid,
	"token_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"contact_email" text,
	"created_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."setup_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."sso_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"identity_id" uuid,
	"idp_session" text,
	"auth_time" timestamp with time zone,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fresh_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
ALTER TABLE "identity"."sso_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."test_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"attempt_id" uuid,
	"outcome" text NOT NULL,
	"reason" text,
	"claims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."test_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."workspace_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"deprovision" text DEFAULT 'membership' NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_settings_deprovision_check" CHECK ("deprovision" in ('membership', 'account'))
);
--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity"."bypass_users" ADD CONSTRAINT "bypass_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."bypass_users" ADD CONSTRAINT "bypass_users_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."connection_domains" ADD CONSTRAINT "connection_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."connection_domains" ADD CONSTRAINT "connection_domains_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."connection_domains" ADD CONSTRAINT "connection_domains_proof_fk" FOREIGN KEY ("join_domain_id","tenant_id") REFERENCES "core"."join_domains"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."connections" ADD CONSTRAINT "connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."identities" ADD CONSTRAINT "identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."identities" ADD CONSTRAINT "identities_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."login_attempts" ADD CONSTRAINT "login_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."login_attempts" ADD CONSTRAINT "login_attempts_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."managed_accounts" ADD CONSTRAINT "managed_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."managed_accounts" ADD CONSTRAINT "managed_accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "identity"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."setup_links" ADD CONSTRAINT "setup_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."setup_links" ADD CONSTRAINT "setup_links_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."sso_sessions" ADD CONSTRAINT "sso_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."sso_sessions" ADD CONSTRAINT "sso_sessions_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."test_runs" ADD CONSTRAINT "test_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."test_runs" ADD CONSTRAINT "test_runs_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD CONSTRAINT "workspace_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_domains_proof_unique" ON "identity"."connection_domains" USING btree ("join_domain_id");--> statement-breakpoint
CREATE INDEX "connections_tenant_idx" ON "identity"."connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "events_tenant_created_idx" ON "identity"."events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "identity"."events" USING btree ("tenant_id","subject_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_connection_subject_unique" ON "identity"."identities" USING btree ("connection_id","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_connection_user_unique" ON "identity"."identities" USING btree ("connection_id","clerk_user_id");--> statement-breakpoint
CREATE INDEX "identities_user_idx" ON "identity"."identities" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "login_attempts_state_unique" ON "identity"."login_attempts" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "login_attempts_handoff_code_unique" ON "identity"."login_attempts" USING btree ("handoff_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "login_attempts_handoff_secret_unique" ON "identity"."login_attempts" USING btree ("handoff_secret_hash");--> statement-breakpoint
CREATE INDEX "login_attempts_tenant_idx" ON "identity"."login_attempts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "managed_accounts_tenant_idx" ON "identity"."managed_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "managed_accounts_emails_idx" ON "identity"."managed_accounts" USING gin ("emails");--> statement-breakpoint
CREATE UNIQUE INDEX "setup_links_token_unique" ON "identity"."setup_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "setup_links_tenant_idx" ON "identity"."setup_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sso_sessions_user_idx" ON "identity"."sso_sessions" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "sso_sessions_tenant_user_idx" ON "identity"."sso_sessions" USING btree ("tenant_id","clerk_user_id");--> statement-breakpoint
CREATE INDEX "sso_sessions_idp_session_idx" ON "identity"."sso_sessions" USING btree ("connection_id","idp_session");--> statement-breakpoint
CREATE INDEX "test_runs_connection_idx" ON "identity"."test_runs" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE POLICY "bypass_users_workspace" ON "identity"."bypass_users" AS PERMISSIVE FOR ALL TO public USING ("identity"."bypass_users"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."bypass_users"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "connection_domains_workspace" ON "identity"."connection_domains" AS PERMISSIVE FOR ALL TO public USING ("identity"."connection_domains"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."connection_domains"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "connections_workspace" ON "identity"."connections" AS PERMISSIVE FOR ALL TO public USING ("identity"."connections"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."connections"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "connections_start_read" ON "identity"."connections" AS PERMISSIVE FOR SELECT TO public USING ("identity"."connections"."id"::text = nullif(current_setting('app.connection_id', true), ''));--> statement-breakpoint
CREATE POLICY "events_workspace" ON "identity"."events" AS PERMISSIVE FOR SELECT TO public USING ("identity"."events"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "events_workspace_insert" ON "identity"."events" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("identity"."events"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "identities_workspace" ON "identity"."identities" AS PERMISSIVE FOR ALL TO public USING ("identity"."identities"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."identities"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "login_attempts_workspace" ON "identity"."login_attempts" AS PERMISSIVE FOR ALL TO public USING ("identity"."login_attempts"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."login_attempts"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "login_attempts_state_read" ON "identity"."login_attempts" AS PERMISSIVE FOR SELECT TO public USING ("identity"."login_attempts"."state_hash" = nullif(current_setting('app.attempt_state', true), ''));--> statement-breakpoint
CREATE POLICY "login_attempts_handoff_read" ON "identity"."login_attempts" AS PERMISSIVE FOR SELECT TO public USING ("identity"."login_attempts"."handoff_code_hash" = nullif(current_setting('app.handoff_code', true), ''));--> statement-breakpoint
CREATE POLICY "login_attempts_bind_read" ON "identity"."login_attempts" AS PERMISSIVE FOR SELECT TO public USING ("identity"."login_attempts"."handoff_secret_hash" = nullif(current_setting('app.handoff_secret', true), ''));--> statement-breakpoint
CREATE POLICY "managed_accounts_workspace" ON "identity"."managed_accounts" AS PERMISSIVE FOR ALL TO public USING ("identity"."managed_accounts"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."managed_accounts"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "managed_accounts_user_read" ON "identity"."managed_accounts" AS PERMISSIVE FOR SELECT TO public USING ("identity"."managed_accounts"."clerk_user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "managed_accounts_identifier_read" ON "identity"."managed_accounts" AS PERMISSIVE FOR SELECT TO public USING (nullif(current_setting('app.identifier', true), '') = any("identity"."managed_accounts"."emails"));--> statement-breakpoint
CREATE POLICY "setup_links_workspace" ON "identity"."setup_links" AS PERMISSIVE FOR ALL TO public USING ("identity"."setup_links"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."setup_links"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "sso_sessions_workspace" ON "identity"."sso_sessions" AS PERMISSIVE FOR ALL TO public USING ("identity"."sso_sessions"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."sso_sessions"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "sso_sessions_user_read" ON "identity"."sso_sessions" AS PERMISSIVE FOR SELECT TO public USING ("identity"."sso_sessions"."clerk_user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "test_runs_workspace" ON "identity"."test_runs" AS PERMISSIVE FOR ALL TO public USING ("identity"."test_runs"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."test_runs"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "workspace_settings_workspace" ON "identity"."workspace_settings" AS PERMISSIVE FOR ALL TO public USING ("identity"."workspace_settings"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."workspace_settings"."tenant_id" = current_setting('app.tenant_id')::uuid);