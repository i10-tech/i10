SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "core"."meter_usage_hourly" (
	"tenant_id" uuid,
	"feature_id" text,
	"shard" integer,
	"hour" timestamp with time zone,
	"slot" smallint,
	"used" bigint NOT NULL,
	CONSTRAINT "meter_usage_hourly_pkey" PRIMARY KEY("tenant_id","feature_id","shard","hour","slot")
);
--> statement-breakpoint
ALTER TABLE "core"."meter_usage_hourly" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."meter_usage_hourly" ADD CONSTRAINT "meter_usage_hourly_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "meter_usage_hourly_read" ON "core"."meter_usage_hourly" AS PERMISSIVE FOR SELECT TO public USING ("core"."meter_usage_hourly"."tenant_id" = current_setting('app.tenant_id')::uuid);