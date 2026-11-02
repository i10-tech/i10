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
ALTER TABLE "identity"."connections" ADD COLUMN "relink" text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."connections" ADD COLUMN "upn_as_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."directories" ADD COLUMN "allow_drop_up_to" integer;--> statement-breakpoint
ALTER TABLE "identity"."directories" ADD COLUMN "allow_drop_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity"."relink_requests" ADD CONSTRAINT "relink_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."relink_requests" ADD CONSTRAINT "relink_requests_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "identity"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."relink_requests" ADD CONSTRAINT "relink_requests_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relink_requests_identity_unique" ON "identity"."relink_requests" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "relink_requests_connection_idx" ON "identity"."relink_requests" USING btree ("connection_id","created_at");--> statement-breakpoint
ALTER TABLE "identity"."connections" ADD CONSTRAINT "connections_relink_check" CHECK ("relink" in ('ask', 'auto'));--> statement-breakpoint
ALTER TABLE "identity"."directories" ADD CONSTRAINT "directories_allow_drop_check" CHECK (("allow_drop_up_to" is null and "allow_drop_at" is null) or ("allow_drop_up_to" >= 0 and "allow_drop_at" is not null));--> statement-breakpoint
CREATE POLICY "relink_requests_workspace" ON "identity"."relink_requests" AS PERMISSIVE FOR ALL TO public USING ("identity"."relink_requests"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."relink_requests"."tenant_id" = current_setting('app.tenant_id')::uuid);