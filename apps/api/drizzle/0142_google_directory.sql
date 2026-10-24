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
ALTER TABLE "identity"."directories" ADD COLUMN "admin_email" text;--> statement-breakpoint
ALTER TABLE "identity"."directories" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "identity"."directories" ADD COLUMN "last_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity"."directories" ADD COLUMN "last_sync_status" text;--> statement-breakpoint
ALTER TABLE "identity"."directories" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "identity"."directory_watch_channels" ADD CONSTRAINT "directory_watch_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_watch_channels" ADD CONSTRAINT "directory_watch_channels_directory_fk" FOREIGN KEY ("directory_id","tenant_id") REFERENCES "identity"."directories"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "directory_watch_channels_directory_idx" ON "identity"."directory_watch_channels" USING btree ("directory_id");--> statement-breakpoint
ALTER TABLE "identity"."directories" ADD CONSTRAINT "directories_last_sync_status_check" CHECK ("last_sync_status" is null or "last_sync_status" in ('ok', 'failed'));--> statement-breakpoint
CREATE POLICY "directory_watch_channels_workspace" ON "identity"."directory_watch_channels" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_watch_channels"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_watch_channels"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_watch_channels_id_read" ON "identity"."directory_watch_channels" AS PERMISSIVE FOR SELECT TO public USING ("identity"."directory_watch_channels"."id"::text = nullif(current_setting('app.google_channel', true), ''));