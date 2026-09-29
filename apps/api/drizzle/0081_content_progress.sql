ALTER TABLE "core"."message_bodies" ADD COLUMN "examined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "content_bands" text[];--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "analysed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "fingerprinted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "message_bodies_unexamined_idx" ON "core"."message_bodies" USING btree ("tenant_id","created_at") WHERE "core"."message_bodies"."examined_at" is null and "core"."message_bodies"."compacted_at" is null;--> statement-breakpoint
CREATE INDEX "message_bodies_candidates_idx" ON "core"."message_bodies" USING gin ("content_bands") WHERE "core"."message_bodies"."template_id" is null and "core"."message_bodies"."compacted_at" is null;--> statement-breakpoint
CREATE INDEX "message_bodies_linked_idx" ON "core"."message_bodies" USING btree ("template_id") WHERE "core"."message_bodies"."template_id" is not null and "core"."message_bodies"."compacted_at" is null;--> statement-breakpoint
CREATE INDEX "message_bodies_unanalysed_idx" ON "core"."message_bodies" USING btree ("tenant_id","created_at") WHERE "core"."message_bodies"."analysed_at" is null;--> statement-breakpoint
CREATE INDEX "message_bodies_unfingerprinted_idx" ON "core"."message_bodies" USING btree ("tenant_id","created_at") WHERE "core"."message_bodies"."fingerprinted_at" is null;