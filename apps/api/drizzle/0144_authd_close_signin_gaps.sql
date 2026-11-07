CREATE TABLE "authd"."required_domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authd"."accounts" ALTER COLUMN "credential_epoch" SET DEFAULT (extract(epoch from clock_timestamp()) * 1000000)::bigint;--> statement-breakpoint
ALTER TABLE "authd"."accounts" ADD COLUMN "payment_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "authd"."accounts" ADD COLUMN "banned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "authd"."accounts" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "authd"."accounts" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "authd"."required_domains" ADD CONSTRAINT "required_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authd"."required_domains" ADD CONSTRAINT "authd_required_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "identity"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "required_domains_tenant_idx" ON "authd"."required_domains" USING btree ("tenant_id");