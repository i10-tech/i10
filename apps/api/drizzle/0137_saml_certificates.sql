CREATE TABLE "identity"."saml_certificates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"certificate" text NOT NULL,
	"subject" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"alerted_days" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saml_certificates_source_check" CHECK ("source" in ('upload', 'metadata'))
);
--> statement-breakpoint
ALTER TABLE "identity"."saml_certificates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity"."saml_certificates" ADD CONSTRAINT "saml_certificates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."saml_certificates" ADD CONSTRAINT "saml_certificates_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saml_certificates_connection_fingerprint_unique" ON "identity"."saml_certificates" USING btree ("connection_id","fingerprint");--> statement-breakpoint
CREATE INDEX "saml_certificates_not_after_idx" ON "identity"."saml_certificates" USING btree ("not_after");--> statement-breakpoint
CREATE POLICY "saml_certificates_workspace" ON "identity"."saml_certificates" AS PERMISSIVE FOR ALL TO public USING ("identity"."saml_certificates"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."saml_certificates"."tenant_id" = current_setting('app.tenant_id')::uuid);