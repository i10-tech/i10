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
ALTER TABLE "identity"."setup_links" ALTER COLUMN "connection_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "owner_exemption" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "exemption_off_requested_by" text;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "exemption_off_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity"."bypass_sign_ins" ADD CONSTRAINT "bypass_sign_ins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."bypass_sign_ins" ADD CONSTRAINT "bypass_sign_ins_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD CONSTRAINT "workspace_settings_exemption_request_check" CHECK (("exemption_off_requested_by" is null) = ("exemption_off_requested_at" is null));--> statement-breakpoint
CREATE POLICY "setup_links_hash_read" ON "identity"."setup_links" AS PERMISSIVE FOR SELECT TO public USING ("identity"."setup_links"."token_hash" = nullif(current_setting('app.setup_token', true), ''));--> statement-breakpoint
CREATE POLICY "bypass_sign_ins_workspace" ON "identity"."bypass_sign_ins" AS PERMISSIVE FOR ALL TO public USING ("identity"."bypass_sign_ins"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."bypass_sign_ins"."tenant_id" = current_setting('app.tenant_id')::uuid);