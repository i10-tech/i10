CREATE TABLE "core"."content_packs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"size" bigint NOT NULL,
	"bodies" integer NOT NULL,
	"raw_size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."content_packs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "pack_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "pack_offset" bigint;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "pack_length" integer;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "body_key" text;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "packed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "content_packs_tenant_created_idx" ON "core"."content_packs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "message_bodies_pack_idx" ON "core"."message_bodies" USING btree ("pack_id") WHERE "core"."message_bodies"."pack_id" is not null;--> statement-breakpoint
CREATE INDEX "message_bodies_unpacked_idx" ON "core"."message_bodies" USING btree ("tenant_id","created_at") WHERE "core"."message_bodies"."pack_id" is null and "core"."message_bodies"."compacted_at" is null and ("core"."message_bodies"."html" is not null or "core"."message_bodies"."text" is not null);--> statement-breakpoint
CREATE POLICY "content_packs_tenant" ON "core"."content_packs" AS PERMISSIVE FOR ALL TO public USING ("core"."content_packs"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."content_packs"."tenant_id" = current_setting('app.tenant_id')::uuid);