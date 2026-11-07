CREATE SCHEMA "identity";
--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'member.provisioned';--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'member.deprovisioned';--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'sso.connection.failed';--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'sso.certificate.expiring';--> statement-breakpoint
CREATE TABLE "authd"."managed_accounts" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"connection_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."workspace_roles" (
	"tenant_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"role" text NOT NULL,
	"clerk_membership_id" text,
	"source" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_roles_tenant_id_clerk_user_id_pk" PRIMARY KEY("tenant_id","clerk_user_id"),
	CONSTRAINT "workspace_roles_role_check" CHECK ("role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
ALTER TABLE "core"."workspace_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."bypass_sign_ins" (
	"tenant_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"clerk_user_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bypass_sign_ins_tenant_id_session_id_pk" PRIMARY KEY("tenant_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "identity"."bypass_sign_ins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
	"groups_last_seen_at" timestamp with time zone,
	"relink" text DEFAULT 'ask' NOT NULL,
	"upn_as_email" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "connections_protocol_check" CHECK ("protocol" in ('oidc', 'saml', 'test')),
	CONSTRAINT "connections_status_check" CHECK ("status" in ('draft', 'testing', 'active', 'disabled')),
	CONSTRAINT "connections_enforcement_check" CHECK ("enforcement" in ('off', 'optional', 'required_domain', 'required_all')),
	CONSTRAINT "connections_relink_check" CHECK ("relink" in ('ask', 'auto')),
	CONSTRAINT "connections_session_limits_check" CHECK (("max_session_seconds" is null or "max_session_seconds" >= 300) and ("idle_timeout_seconds" is null or "idle_timeout_seconds" >= 300))
);
--> statement-breakpoint
ALTER TABLE "identity"."connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'generic' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"create_mailboxes" boolean DEFAULT false NOT NULL,
	"admin_email" text,
	"domain" text,
	"last_sync_at" timestamp with time zone,
	"last_sync_status" text,
	"last_sync_error" text,
	"allow_drop_up_to" integer,
	"allow_drop_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directories_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "directories_provider_check" CHECK ("provider" in ('okta', 'entra', 'google', 'generic')),
	CONSTRAINT "directories_last_sync_status_check" CHECK ("last_sync_status" is null or "last_sync_status" in ('ok', 'failed')),
	CONSTRAINT "directories_allow_drop_check" CHECK (("allow_drop_up_to" is null and "allow_drop_at" is null) or ("allow_drop_up_to" >= 0 and "allow_drop_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "identity"."directories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directory_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"directory_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text,
	"resource" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mail_address" text,
	"mail_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_groups_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "directory_groups_id_directory_tenant_unique" UNIQUE("id","directory_id","tenant_id"),
	CONSTRAINT "directory_groups_mail_check" CHECK (("mail_address" is null) = ("mail_kind" is null) and ("mail_kind" is null or "mail_kind" in ('list', 'shared')))
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directory_mailboxes" (
	"tenant_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"address" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp with time zone,
	"next" text DEFAULT 'keep' NOT NULL,
	"target_user_id" text,
	"delete_after_days" integer,
	"delete_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_mailboxes_tenant_id_clerk_user_id_pk" PRIMARY KEY("tenant_id","clerk_user_id"),
	CONSTRAINT "directory_mailboxes_state_check" CHECK ("state" in ('active', 'suspended')),
	CONSTRAINT "directory_mailboxes_next_check" CHECK ("next" in ('keep', 'forward_manager', 'delegate', 'delete')),
	CONSTRAINT "directory_mailboxes_target_check" CHECK ((("next" in ('forward_manager', 'delegate')) = ("target_user_id" is not null))),
	CONSTRAINT "directory_mailboxes_delete_check" CHECK ((("next" = 'delete') = ("delete_at" is not null)) and (("next" = 'delete') = ("delete_after_days" is not null)) and ("delete_after_days" is null or "delete_after_days" between 7 and 365)),
	CONSTRAINT "directory_mailboxes_suspended_check" CHECK (("state" = 'suspended') = ("suspended_at" is not null) and ("state" = 'suspended' or "next" = 'keep'))
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_mailboxes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directory_memberships" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"directory_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_memberships_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directory_outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"directory_id" uuid NOT NULL,
	"directory_user_id" uuid NOT NULL,
	"cause" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "directory_outbox_cause_check" CHECK ("cause" in ('created', 'updated', 'deleted', 'group'))
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directory_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"directory_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"hint" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directory_users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"directory_id" uuid NOT NULL,
	"user_name" text NOT NULL,
	"external_id" text,
	"display_name" text,
	"given_name" text,
	"family_name" text,
	"email" text,
	"active" boolean DEFAULT true NOT NULL,
	"resource" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"clerk_user_id" text,
	"conflict" text,
	"conflict_detail" jsonb,
	"conflict_at" timestamp with time zone,
	"banned_by_directory" boolean DEFAULT false NOT NULL,
	"aliases_ignored" integer DEFAULT 0 NOT NULL,
	"mailbox_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "directory_users_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "directory_users_id_directory_tenant_unique" UNIQUE("id","directory_id","tenant_id"),
	CONSTRAINT "directory_users_mailbox_note_check" CHECK ("mailbox_note" is null or "mailbox_note" in ('domain_not_hosted', 'limit', 'address_taken')),
	CONSTRAINT "directory_users_conflict_check" CHECK ("conflict" is null or "conflict" in ('workspace_full', 'blocked', 'banned', 'domain_not_verified', 'address_taken', 'ambiguous_account', 'managed_elsewhere', 'role_exempt', 'already_linked', 'no_email', 'profile_incomplete', 'last_owner', 'account_deleted', 'no_sso_connection'))
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directory_watch_channels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"directory_id" uuid NOT NULL,
	"event" text NOT NULL,
	"resource_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_watch_channels_event_check" CHECK ("event" in ('add', 'update', 'delete', 'undelete'))
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_watch_channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
CREATE TABLE "identity"."group_role_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"group_value" text NOT NULL,
	"role" text NOT NULL,
	"precedence" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_role_rules_role_check" CHECK ("role" in ('member', 'admin')),
	CONSTRAINT "group_role_rules_precedence_check" CHECK ("precedence" >= 0 and "precedence" <= 10000)
);
--> statement-breakpoint
ALTER TABLE "identity"."group_role_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
	"login_hint" text,
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
CREATE TABLE "identity"."relink_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"new_subject" text NOT NULL,
	"email_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."relink_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."saml_certificates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"certificate" text NOT NULL,
	"subject" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"alerted_days" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saml_certificates_source_check" CHECK ("source" in ('upload', 'metadata'))
);
--> statement-breakpoint
ALTER TABLE "identity"."saml_certificates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."session_activity" (
	"tenant_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"clerk_user_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "session_activity_tenant_id_session_id_pk" PRIMARY KEY("tenant_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "identity"."session_activity" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."setup_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
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
CREATE TABLE "identity"."siem_exports" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"bucket" text NOT NULL,
	"region" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_hint" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_event_id" uuid,
	"last_export_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."siem_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
	"owner_exemption" boolean DEFAULT true NOT NULL,
	"leaver_action" text DEFAULT 'keep' NOT NULL,
	"leaver_days" integer,
	"exemption_off_requested_by" text,
	"exemption_off_requested_at" timestamp with time zone,
	"max_session_seconds" integer,
	"idle_timeout_seconds" integer,
	"require_second_factor" boolean DEFAULT false NOT NULL,
	"ip_allowlist_console" boolean DEFAULT false NOT NULL,
	"ip_allowlist_api_keys" boolean DEFAULT false NOT NULL,
	"ip_ranges" text[] DEFAULT '{}'::text[] NOT NULL,
	"ip_grace_user_id" text,
	"ip_grace_address" text,
	"ip_grace_until" timestamp with time zone,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_settings_deprovision_check" CHECK ("deprovision" in ('membership', 'account')),
	CONSTRAINT "workspace_settings_leaver_check" CHECK ("leaver_action" in ('keep', 'forward_manager', 'delete_after') and (("leaver_action" = 'delete_after') = ("leaver_days" is not null)) and ("leaver_days" is null or "leaver_days" between 7 and 365)),
	CONSTRAINT "workspace_settings_exemption_request_check" CHECK (("exemption_off_requested_by" is null) = ("exemption_off_requested_at" is null)),
	CONSTRAINT "workspace_settings_session_bounds_check" CHECK (("max_session_seconds" is null or "max_session_seconds" between 900 and 7776000)
        and ("idle_timeout_seconds" is null or "idle_timeout_seconds" between 300 and 2592000)),
	CONSTRAINT "workspace_settings_ip_ranges_check" CHECK (cardinality("ip_ranges") <= 100),
	CONSTRAINT "workspace_settings_ip_grace_check" CHECK (("ip_grace_user_id" is null) = ("ip_grace_address" is null)
        and ("ip_grace_user_id" is null) = ("ip_grace_until" is null))
);
--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "authd"."accounts" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "authd"."aliases" ADD COLUMN "source" text DEFAULT 'clerk' NOT NULL;--> statement-breakpoint
ALTER TABLE "authd"."groups" ADD COLUMN "directory_group_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."member_invitations" ADD COLUMN "applied_membership_id" text;--> statement-breakpoint
ALTER TABLE "core"."member_invitations" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
-- Moved up from the end of the generated file by hand: drizzle-kit writes unique
-- constraints after foreign keys, and "connection_domains_proof_fk" below needs this one.
ALTER TABLE "core"."join_domains" ADD CONSTRAINT "join_domains_id_tenant_unique" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "authd"."managed_accounts" ADD CONSTRAINT "authd_managed_user_fk" FOREIGN KEY ("clerk_user_id") REFERENCES "identity"."managed_accounts"("clerk_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authd"."managed_accounts" ADD CONSTRAINT "authd_managed_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "identity"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."workspace_roles" ADD CONSTRAINT "workspace_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."bypass_sign_ins" ADD CONSTRAINT "bypass_sign_ins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."bypass_sign_ins" ADD CONSTRAINT "bypass_sign_ins_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."bypass_users" ADD CONSTRAINT "bypass_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."bypass_users" ADD CONSTRAINT "bypass_users_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."connection_domains" ADD CONSTRAINT "connection_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."connection_domains" ADD CONSTRAINT "connection_domains_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."connection_domains" ADD CONSTRAINT "connection_domains_proof_fk" FOREIGN KEY ("join_domain_id","tenant_id") REFERENCES "core"."join_domains"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."connections" ADD CONSTRAINT "connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directories" ADD CONSTRAINT "directories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_groups" ADD CONSTRAINT "directory_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_groups" ADD CONSTRAINT "directory_groups_directory_fk" FOREIGN KEY ("directory_id","tenant_id") REFERENCES "identity"."directories"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_mailboxes" ADD CONSTRAINT "directory_mailboxes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_memberships" ADD CONSTRAINT "directory_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_memberships" ADD CONSTRAINT "directory_memberships_group_fk" FOREIGN KEY ("group_id","directory_id","tenant_id") REFERENCES "identity"."directory_groups"("id","directory_id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_memberships" ADD CONSTRAINT "directory_memberships_user_fk" FOREIGN KEY ("user_id","directory_id","tenant_id") REFERENCES "identity"."directory_users"("id","directory_id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_outbox" ADD CONSTRAINT "directory_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_outbox" ADD CONSTRAINT "directory_outbox_user_fk" FOREIGN KEY ("directory_user_id","directory_id","tenant_id") REFERENCES "identity"."directory_users"("id","directory_id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_tokens" ADD CONSTRAINT "directory_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_tokens" ADD CONSTRAINT "directory_tokens_directory_fk" FOREIGN KEY ("directory_id","tenant_id") REFERENCES "identity"."directories"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_users" ADD CONSTRAINT "directory_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_users" ADD CONSTRAINT "directory_users_directory_fk" FOREIGN KEY ("directory_id","tenant_id") REFERENCES "identity"."directories"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_watch_channels" ADD CONSTRAINT "directory_watch_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_watch_channels" ADD CONSTRAINT "directory_watch_channels_directory_fk" FOREIGN KEY ("directory_id","tenant_id") REFERENCES "identity"."directories"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."group_role_rules" ADD CONSTRAINT "group_role_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."group_role_rules" ADD CONSTRAINT "group_role_rules_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."identities" ADD CONSTRAINT "identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."identities" ADD CONSTRAINT "identities_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."login_attempts" ADD CONSTRAINT "login_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."login_attempts" ADD CONSTRAINT "login_attempts_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."managed_accounts" ADD CONSTRAINT "managed_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."managed_accounts" ADD CONSTRAINT "managed_accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "identity"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."relink_requests" ADD CONSTRAINT "relink_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."relink_requests" ADD CONSTRAINT "relink_requests_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "identity"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."relink_requests" ADD CONSTRAINT "relink_requests_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."saml_certificates" ADD CONSTRAINT "saml_certificates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."saml_certificates" ADD CONSTRAINT "saml_certificates_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."session_activity" ADD CONSTRAINT "session_activity_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."setup_links" ADD CONSTRAINT "setup_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."setup_links" ADD CONSTRAINT "setup_links_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."siem_exports" ADD CONSTRAINT "siem_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."sso_sessions" ADD CONSTRAINT "sso_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."sso_sessions" ADD CONSTRAINT "sso_sessions_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."test_runs" ADD CONSTRAINT "test_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."test_runs" ADD CONSTRAINT "test_runs_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD CONSTRAINT "workspace_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_roles_tenant_role_idx" ON "core"."workspace_roles" USING btree ("tenant_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_domains_proof_unique" ON "identity"."connection_domains" USING btree ("join_domain_id");--> statement-breakpoint
CREATE INDEX "connections_tenant_idx" ON "identity"."connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "directories_tenant_idx" ON "identity"."directories" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_groups_mail_address_unique" ON "identity"."directory_groups" USING btree (lower("mail_address")) WHERE "identity"."directory_groups"."mail_address" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "directory_groups_display_name_unique" ON "identity"."directory_groups" USING btree ("directory_id",lower("display_name"));--> statement-breakpoint
CREATE INDEX "directory_groups_directory_idx" ON "identity"."directory_groups" USING btree ("directory_id","display_name");--> statement-breakpoint
CREATE INDEX "directory_mailboxes_due_idx" ON "identity"."directory_mailboxes" USING btree ("tenant_id","delete_at") WHERE "identity"."directory_mailboxes"."delete_at" is not null;--> statement-breakpoint
CREATE INDEX "directory_memberships_user_idx" ON "identity"."directory_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "directory_outbox_pending_idx" ON "identity"."directory_outbox" USING btree ("tenant_id","directory_id","created_at") WHERE "identity"."directory_outbox"."applied_at" is null;--> statement-breakpoint
CREATE INDEX "directory_outbox_user_idx" ON "identity"."directory_outbox" USING btree ("directory_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_tokens_hash_unique" ON "identity"."directory_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "directory_tokens_directory_idx" ON "identity"."directory_tokens" USING btree ("directory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_users_user_name_unique" ON "identity"."directory_users" USING btree ("directory_id",lower("user_name")) WHERE "identity"."directory_users"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "directory_users_clerk_user_unique" ON "identity"."directory_users" USING btree ("directory_id","clerk_user_id") WHERE "identity"."directory_users"."deleted_at" is null and "identity"."directory_users"."clerk_user_id" is not null;--> statement-breakpoint
CREATE INDEX "directory_users_tenant_user_idx" ON "identity"."directory_users" USING btree ("tenant_id","clerk_user_id");--> statement-breakpoint
CREATE INDEX "directory_users_external_idx" ON "identity"."directory_users" USING btree ("directory_id","external_id");--> statement-breakpoint
CREATE INDEX "directory_users_email_idx" ON "identity"."directory_users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "directory_watch_channels_directory_idx" ON "identity"."directory_watch_channels" USING btree ("directory_id");--> statement-breakpoint
CREATE INDEX "events_tenant_created_idx" ON "identity"."events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "events_subject_idx" ON "identity"."events" USING btree ("tenant_id","subject_user_id");--> statement-breakpoint
CREATE INDEX "events_connection_type_idx" ON "identity"."events" USING btree ("tenant_id","connection_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_tenant_id_idx" ON "identity"."events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_role_rules_connection_group_unique" ON "identity"."group_role_rules" USING btree ("connection_id","group_value");--> statement-breakpoint
CREATE INDEX "group_role_rules_connection_idx" ON "identity"."group_role_rules" USING btree ("connection_id","precedence");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_connection_subject_unique" ON "identity"."identities" USING btree ("connection_id","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_connection_user_unique" ON "identity"."identities" USING btree ("connection_id","clerk_user_id");--> statement-breakpoint
CREATE INDEX "identities_user_idx" ON "identity"."identities" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "login_attempts_state_unique" ON "identity"."login_attempts" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "login_attempts_handoff_code_unique" ON "identity"."login_attempts" USING btree ("handoff_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "login_attempts_handoff_secret_unique" ON "identity"."login_attempts" USING btree ("handoff_secret_hash");--> statement-breakpoint
CREATE INDEX "login_attempts_tenant_idx" ON "identity"."login_attempts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "managed_accounts_tenant_idx" ON "identity"."managed_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "managed_accounts_emails_idx" ON "identity"."managed_accounts" USING gin ("emails");--> statement-breakpoint
CREATE UNIQUE INDEX "relink_requests_identity_unique" ON "identity"."relink_requests" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "relink_requests_connection_idx" ON "identity"."relink_requests" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "saml_certificates_connection_fingerprint_unique" ON "identity"."saml_certificates" USING btree ("connection_id","fingerprint");--> statement-breakpoint
CREATE INDEX "saml_certificates_not_after_idx" ON "identity"."saml_certificates" USING btree ("not_after");--> statement-breakpoint
CREATE INDEX "session_activity_seen_idx" ON "identity"."session_activity" USING btree ("tenant_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "setup_links_token_unique" ON "identity"."setup_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "setup_links_tenant_idx" ON "identity"."setup_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sso_sessions_user_idx" ON "identity"."sso_sessions" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "sso_sessions_tenant_user_idx" ON "identity"."sso_sessions" USING btree ("tenant_id","clerk_user_id");--> statement-breakpoint
CREATE INDEX "sso_sessions_idp_session_idx" ON "identity"."sso_sessions" USING btree ("connection_id","idp_session");--> statement-breakpoint
CREATE INDEX "test_runs_connection_idx" ON "identity"."test_runs" USING btree ("connection_id","created_at");--> statement-breakpoint
ALTER TABLE "authd"."groups" ADD CONSTRAINT "authd_groups_directory_group_fk" FOREIGN KEY ("directory_group_id") REFERENCES "identity"."directory_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authd"."aliases" ADD CONSTRAINT "aliases_source_check" CHECK ("source" in ('clerk', 'directory'));--> statement-breakpoint
CREATE POLICY "workspace_roles_workspace" ON "core"."workspace_roles" AS PERMISSIVE FOR ALL TO public USING ("core"."workspace_roles"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."workspace_roles"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "bypass_sign_ins_workspace" ON "identity"."bypass_sign_ins" AS PERMISSIVE FOR ALL TO public USING ("identity"."bypass_sign_ins"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."bypass_sign_ins"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "bypass_users_workspace" ON "identity"."bypass_users" AS PERMISSIVE FOR ALL TO public USING ("identity"."bypass_users"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."bypass_users"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "connection_domains_workspace" ON "identity"."connection_domains" AS PERMISSIVE FOR ALL TO public USING ("identity"."connection_domains"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."connection_domains"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "connections_workspace" ON "identity"."connections" AS PERMISSIVE FOR ALL TO public USING ("identity"."connections"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."connections"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "connections_start_read" ON "identity"."connections" AS PERMISSIVE FOR SELECT TO public USING ("identity"."connections"."id"::text = nullif(current_setting('app.connection_id', true), ''));--> statement-breakpoint
CREATE POLICY "directories_workspace" ON "identity"."directories" AS PERMISSIVE FOR ALL TO public USING ("identity"."directories"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directories"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_groups_workspace" ON "identity"."directory_groups" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_groups"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_groups"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_mailboxes_workspace" ON "identity"."directory_mailboxes" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_mailboxes"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_mailboxes"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_memberships_workspace" ON "identity"."directory_memberships" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_memberships"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_memberships"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_outbox_workspace" ON "identity"."directory_outbox" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_outbox"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_outbox"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_tokens_workspace" ON "identity"."directory_tokens" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_tokens"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_tokens"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_tokens_hash_read" ON "identity"."directory_tokens" AS PERMISSIVE FOR SELECT TO public USING ("identity"."directory_tokens"."token_hash" = nullif(current_setting('app.scim_token', true), ''));--> statement-breakpoint
CREATE POLICY "directory_users_workspace" ON "identity"."directory_users" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_users"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_users"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_watch_channels_workspace" ON "identity"."directory_watch_channels" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_watch_channels"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_watch_channels"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_watch_channels_id_read" ON "identity"."directory_watch_channels" AS PERMISSIVE FOR SELECT TO public USING ("identity"."directory_watch_channels"."id"::text = nullif(current_setting('app.google_channel', true), ''));--> statement-breakpoint
CREATE POLICY "events_workspace" ON "identity"."events" AS PERMISSIVE FOR SELECT TO public USING ("identity"."events"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "events_workspace_insert" ON "identity"."events" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("identity"."events"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "group_role_rules_workspace" ON "identity"."group_role_rules" AS PERMISSIVE FOR ALL TO public USING ("identity"."group_role_rules"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."group_role_rules"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "identities_workspace" ON "identity"."identities" AS PERMISSIVE FOR ALL TO public USING ("identity"."identities"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."identities"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "login_attempts_workspace" ON "identity"."login_attempts" AS PERMISSIVE FOR ALL TO public USING ("identity"."login_attempts"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."login_attempts"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "login_attempts_state_read" ON "identity"."login_attempts" AS PERMISSIVE FOR SELECT TO public USING ("identity"."login_attempts"."state_hash" = nullif(current_setting('app.attempt_state', true), ''));--> statement-breakpoint
CREATE POLICY "login_attempts_handoff_read" ON "identity"."login_attempts" AS PERMISSIVE FOR SELECT TO public USING ("identity"."login_attempts"."handoff_code_hash" = nullif(current_setting('app.handoff_code', true), ''));--> statement-breakpoint
CREATE POLICY "login_attempts_bind_read" ON "identity"."login_attempts" AS PERMISSIVE FOR SELECT TO public USING ("identity"."login_attempts"."handoff_secret_hash" = nullif(current_setting('app.handoff_secret', true), ''));--> statement-breakpoint
CREATE POLICY "managed_accounts_workspace" ON "identity"."managed_accounts" AS PERMISSIVE FOR ALL TO public USING ("identity"."managed_accounts"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."managed_accounts"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "managed_accounts_user_read" ON "identity"."managed_accounts" AS PERMISSIVE FOR SELECT TO public USING ("identity"."managed_accounts"."clerk_user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "managed_accounts_identifier_read" ON "identity"."managed_accounts" AS PERMISSIVE FOR SELECT TO public USING (nullif(current_setting('app.identifier', true), '') = any("identity"."managed_accounts"."emails"));--> statement-breakpoint
CREATE POLICY "relink_requests_workspace" ON "identity"."relink_requests" AS PERMISSIVE FOR ALL TO public USING ("identity"."relink_requests"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."relink_requests"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "saml_certificates_workspace" ON "identity"."saml_certificates" AS PERMISSIVE FOR ALL TO public USING ("identity"."saml_certificates"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."saml_certificates"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "session_activity_workspace" ON "identity"."session_activity" AS PERMISSIVE FOR ALL TO public USING ("identity"."session_activity"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."session_activity"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "setup_links_workspace" ON "identity"."setup_links" AS PERMISSIVE FOR ALL TO public USING ("identity"."setup_links"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."setup_links"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "setup_links_hash_read" ON "identity"."setup_links" AS PERMISSIVE FOR SELECT TO public USING ("identity"."setup_links"."token_hash" = nullif(current_setting('app.setup_token', true), ''));--> statement-breakpoint
CREATE POLICY "siem_exports_workspace" ON "identity"."siem_exports" AS PERMISSIVE FOR ALL TO public USING ("identity"."siem_exports"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."siem_exports"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "sso_sessions_workspace" ON "identity"."sso_sessions" AS PERMISSIVE FOR ALL TO public USING ("identity"."sso_sessions"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."sso_sessions"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "sso_sessions_user_read" ON "identity"."sso_sessions" AS PERMISSIVE FOR SELECT TO public USING ("identity"."sso_sessions"."clerk_user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "test_runs_workspace" ON "identity"."test_runs" AS PERMISSIVE FOR ALL TO public USING ("identity"."test_runs"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."test_runs"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "workspace_settings_workspace" ON "identity"."workspace_settings" AS PERMISSIVE FOR ALL TO public USING ("identity"."workspace_settings"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."workspace_settings"."tenant_id" = current_setting('app.tenant_id')::uuid);