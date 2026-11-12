CREATE TYPE "core"."risk_judge_second" AS ENUM('not_needed', 'answered', 'unavailable', 'over_budget', 'not_configured');--> statement-breakpoint
CREATE TABLE "core"."risk_content_judge_days" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"seen" integer DEFAULT 0 NOT NULL,
	"judged" integer DEFAULT 0 NOT NULL,
	"capped" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "risk_content_judge_days_tenant_id_day_pk" PRIMARY KEY("tenant_id","day")
);
--> statement-breakpoint
ALTER TABLE "core"."risk_content_judge_days" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."risk_content_judgements" (
	"tenant_id" uuid NOT NULL,
	"exact" text NOT NULL,
	"model" text NOT NULL,
	"answers" jsonb NOT NULL,
	"truncated" boolean NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"second_status" "core"."risk_judge_second" NOT NULL,
	"second_model" text,
	"second_answers" jsonb,
	"second_truncated" boolean,
	"second_input_tokens" integer,
	"second_output_tokens" integer,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_content_judgements_tenant_id_exact_model_pk" PRIMARY KEY("tenant_id","exact","model")
);
--> statement-breakpoint
ALTER TABLE "core"."risk_content_judgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "judged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."risk_content_judge_days" ADD CONSTRAINT "risk_content_judge_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."risk_content_judgements" ADD CONSTRAINT "risk_content_judgements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_content_judge_days_day_idx" ON "core"."risk_content_judge_days" USING btree ("day");--> statement-breakpoint
CREATE INDEX "risk_content_judgements_judged_idx" ON "core"."risk_content_judgements" USING btree ("judged_at");--> statement-breakpoint
CREATE INDEX "message_bodies_unjudged_idx" ON "core"."message_bodies" USING btree ("tenant_id","created_at") WHERE "core"."message_bodies"."judged_at" is null;--> statement-breakpoint
CREATE POLICY "risk_content_judge_days_deny" ON "core"."risk_content_judge_days" AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "risk_content_judgements_deny" ON "core"."risk_content_judgements" AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);