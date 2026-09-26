CREATE TABLE "core"."domain_transfers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"domain_name" text NOT NULL,
	"recipient_email" text NOT NULL,
	"offered_by" text NOT NULL,
	"from_workspace" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_tenant_id" uuid,
	"declined_at" timestamp with time zone,
	"canceled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "core"."domain_transfers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."domain_transfers" ADD CONSTRAINT "domain_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_transfers_tenant_idx" ON "core"."domain_transfers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "domain_transfers_recipient_idx" ON "core"."domain_transfers" USING btree ("recipient_email");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_transfers_open_unique" ON "core"."domain_transfers" USING btree ("domain_id") WHERE "core"."domain_transfers"."accepted_at" is null and "core"."domain_transfers"."declined_at" is null and "core"."domain_transfers"."canceled_at" is null;--> statement-breakpoint
CREATE POLICY "domain_transfers_sender" ON "core"."domain_transfers" AS PERMISSIVE FOR ALL TO public USING ("core"."domain_transfers"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."domain_transfers"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "domain_transfers_recipient_read" ON "core"."domain_transfers" AS PERMISSIVE FOR SELECT TO public USING ("core"."domain_transfers"."recipient_email" = any(string_to_array(nullif(current_setting('app.recipient_emails', true), ''), ',')));--> statement-breakpoint
CREATE POLICY "domain_transfers_recipient_answer" ON "core"."domain_transfers" AS PERMISSIVE FOR UPDATE TO public USING ("core"."domain_transfers"."recipient_email" = any(string_to_array(nullif(current_setting('app.recipient_emails', true), ''), ','))) WITH CHECK ("core"."domain_transfers"."recipient_email" = any(string_to_array(nullif(current_setting('app.recipient_emails', true), ''), ',')));