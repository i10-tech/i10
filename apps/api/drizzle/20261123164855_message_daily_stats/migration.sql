SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "core"."message_daily_stats" (
	"tenant_id" uuid,
	"day" date,
	"sent" integer NOT NULL,
	"delivered" integer NOT NULL,
	"bounced" integer NOT NULL,
	"complained" integer NOT NULL,
	"delayed" integer NOT NULL,
	"failed" integer NOT NULL,
	CONSTRAINT "message_daily_stats_pkey" PRIMARY KEY("tenant_id","day")
);
--> statement-breakpoint
ALTER TABLE "core"."message_daily_stats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."message_daily_stats_state" (
	"id" boolean PRIMARY KEY DEFAULT true,
	"started_at" timestamp with time zone NOT NULL,
	"complete_before" date NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."message_daily_stats_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."message_daily_stats" ADD CONSTRAINT "message_daily_stats_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "message_daily_stats_read" ON "core"."message_daily_stats" AS PERMISSIVE FOR SELECT TO public USING ("core"."message_daily_stats"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "message_daily_stats_state_read" ON "core"."message_daily_stats_state" AS PERMISSIVE FOR SELECT TO public USING (true);