CREATE TABLE "core"."meter_windows" (
	"tenant_id" uuid NOT NULL,
	"feature_id" text NOT NULL,
	"shard" integer DEFAULT 0 NOT NULL,
	"window_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "meter_windows_tenant_id_feature_id_shard_window_id_pk" PRIMARY KEY("tenant_id","feature_id","shard","window_id")
);
--> statement-breakpoint
ALTER TABLE "core"."meter_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."meter_windows" ADD CONSTRAINT "meter_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "meter_windows_tenant" ON "core"."meter_windows" AS PERMISSIVE FOR ALL TO public USING ("core"."meter_windows"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."meter_windows"."tenant_id" = current_setting('app.tenant_id')::uuid);