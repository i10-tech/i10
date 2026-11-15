CREATE TABLE "authd"."required_exempt" (
	"connection_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "required_exempt_connection_id_clerk_user_id_source_pk" PRIMARY KEY("connection_id","clerk_user_id","source"),
	CONSTRAINT "required_exempt_source_check" CHECK ("source" in ('owner_exemption', 'bypass'))
);
--> statement-breakpoint
ALTER TABLE "authd"."required_exempt" ADD CONSTRAINT "required_exempt_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authd"."required_exempt" ADD CONSTRAINT "authd_exempt_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "identity"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "required_exempt_tenant_idx" ON "authd"."required_exempt" USING btree ("tenant_id");