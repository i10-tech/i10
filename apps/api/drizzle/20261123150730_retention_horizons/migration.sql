SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "core"."retention_horizons" (
	"tenant_id" uuid PRIMARY KEY,
	"oldest_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."retention_horizons" ENABLE ROW LEVEL SECURITY;