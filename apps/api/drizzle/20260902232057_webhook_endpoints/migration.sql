CREATE TYPE "core"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "core"."webhook_event_type" AS ENUM('email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced', 'email.complained', 'email.failed');--> statement-breakpoint
CREATE TABLE "core"."webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_type" "core"."webhook_event_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"message_id" uuid,
	"payload" jsonb NOT NULL,
	"status" "core"."webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"response_status" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"secret_ciphertext" text NOT NULL,
	"events" "core"."webhook_event_type"[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "core"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_idx" ON "core"."webhook_deliveries" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_tenant_idx" ON "core"."webhook_deliveries" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_pending_idx" ON "core"."webhook_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_tenant_idx" ON "core"."webhook_endpoints" USING btree ("tenant_id");