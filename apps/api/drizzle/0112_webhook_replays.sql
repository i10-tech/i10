CREATE TYPE "core"."webhook_replay_kind" AS ENUM('replay', 'replay_missing');--> statement-breakpoint
CREATE TYPE "core"."webhook_replay_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "core"."webhook_replays" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"kind" "core"."webhook_replay_kind" NOT NULL,
	"filter" jsonb NOT NULL,
	"status" "core"."webhook_replay_status" DEFAULT 'queued' NOT NULL,
	"queued" integer DEFAULT 0 NOT NULL,
	"examined" integer DEFAULT 0 NOT NULL,
	"cursor" jsonb,
	"error" text,
	"claimed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "core"."webhook_replays" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."webhook_replays" ADD CONSTRAINT "webhook_replays_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "core"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_replays_endpoint_idx" ON "core"."webhook_replays" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE POLICY "webhook_replays_tenant" ON "core"."webhook_replays" AS PERMISSIVE FOR ALL TO public USING ("core"."webhook_replays"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."webhook_replays"."tenant_id" = current_setting('app.tenant_id')::uuid);