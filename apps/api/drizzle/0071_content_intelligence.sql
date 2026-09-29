CREATE TABLE "core"."behaviour_vectors" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(39) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."behaviour_vectors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."content_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"skeleton_hash" text NOT NULL,
	"segments" jsonb NOT NULL,
	"bands" text[] NOT NULL,
	"static_bytes" integer NOT NULL,
	"holes" integer NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."content_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."content_vectors" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"exact" text NOT NULL,
	"model" text NOT NULL,
	"embedding" halfvec(384) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_vectors_tenant_id_day_exact_model_pk" PRIMARY KEY("tenant_id","day","exact","model")
);
--> statement-breakpoint
ALTER TABLE "core"."content_vectors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "template_values" jsonb;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "compacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."behaviour_vectors" ADD CONSTRAINT "behaviour_vectors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."content_templates" ADD CONSTRAINT "content_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."content_vectors" ADD CONSTRAINT "content_vectors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "behaviour_vectors_hnsw_idx" ON "core"."behaviour_vectors" USING hnsw ("embedding" vector_l2_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "content_templates_skeleton_unique" ON "core"."content_templates" USING btree ("tenant_id","skeleton_hash");--> statement-breakpoint
CREATE INDEX "content_templates_bands_idx" ON "core"."content_templates" USING gin ("bands");--> statement-breakpoint
CREATE INDEX "content_vectors_hnsw_idx" ON "core"."content_vectors" USING hnsw ("embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "content_vectors_day_idx" ON "core"."content_vectors" USING btree ("day");--> statement-breakpoint
CREATE POLICY "behaviour_vectors_tenant" ON "core"."behaviour_vectors" AS PERMISSIVE FOR ALL TO public USING ("core"."behaviour_vectors"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."behaviour_vectors"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "content_templates_tenant" ON "core"."content_templates" AS PERMISSIVE FOR ALL TO public USING ("core"."content_templates"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."content_templates"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "content_vectors_tenant" ON "core"."content_vectors" AS PERMISSIVE FOR ALL TO public USING ("core"."content_vectors"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."content_vectors"."tenant_id" = current_setting('app.tenant_id')::uuid);