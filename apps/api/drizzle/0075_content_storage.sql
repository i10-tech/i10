CREATE TABLE "core"."content_objects" (
	"tenant_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_objects_tenant_id_sha256_pk" PRIMARY KEY("tenant_id","sha256")
);
--> statement-breakpoint
ALTER TABLE "core"."content_objects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."expired_messages" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."expired_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "attachments_stored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."plans" ADD COLUMN "retention_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
CREATE INDEX "content_objects_last_seen_idx" ON "core"."content_objects" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "expired_messages_expired_idx" ON "core"."expired_messages" USING btree ("expired_at");--> statement-breakpoint
CREATE INDEX "message_bodies_tenant_created_idx" ON "core"."message_bodies" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "message_bodies_attachments_pending_idx" ON "core"."message_bodies" USING btree ("created_at") WHERE "core"."message_bodies"."attachments" is not null and "core"."message_bodies"."attachments_stored_at" is null;--> statement-breakpoint
CREATE INDEX "message_bodies_attachments_gin_idx" ON "core"."message_bodies" USING gin ("attachments" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "message_bodies_template_idx" ON "core"."message_bodies" USING btree ("template_id") WHERE "core"."message_bodies"."template_id" is not null;--> statement-breakpoint
CREATE POLICY "content_objects_tenant" ON "core"."content_objects" AS PERMISSIVE FOR ALL TO public USING ("core"."content_objects"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."content_objects"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "expired_messages_tenant" ON "core"."expired_messages" AS PERMISSIVE FOR ALL TO public USING ("core"."expired_messages"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."expired_messages"."tenant_id" = current_setting('app.tenant_id')::uuid);