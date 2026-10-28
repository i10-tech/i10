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
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "max_session_seconds" integer;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "idle_timeout_seconds" integer;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "require_second_factor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "ip_allowlist_console" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "ip_allowlist_api_keys" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "ip_ranges" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "ip_grace_user_id" text;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "ip_grace_address" text;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "ip_grace_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity"."session_activity" ADD CONSTRAINT "session_activity_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_activity_seen_idx" ON "identity"."session_activity" USING btree ("tenant_id","last_seen_at");--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD CONSTRAINT "workspace_settings_session_bounds_check" CHECK (("max_session_seconds" is null or "max_session_seconds" between 900 and 7776000)
        and ("idle_timeout_seconds" is null or "idle_timeout_seconds" between 300 and 2592000));--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD CONSTRAINT "workspace_settings_ip_ranges_check" CHECK (cardinality("ip_ranges") <= 100);--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD CONSTRAINT "workspace_settings_ip_grace_check" CHECK (("ip_grace_user_id" is null) = ("ip_grace_address" is null)
        and ("ip_grace_user_id" is null) = ("ip_grace_until" is null));--> statement-breakpoint
CREATE POLICY "session_activity_workspace" ON "identity"."session_activity" AS PERMISSIVE FOR ALL TO public USING ("identity"."session_activity"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."session_activity"."tenant_id" = current_setting('app.tenant_id')::uuid);