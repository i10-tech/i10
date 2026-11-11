DROP POLICY "behaviour_vectors_tenant" ON "core"."behaviour_vectors" CASCADE;--> statement-breakpoint
DROP TABLE "core"."behaviour_vectors" CASCADE;--> statement-breakpoint
DROP POLICY "risk_models_deny" ON "core"."risk_models" CASCADE;--> statement-breakpoint
DROP TABLE "core"."risk_models" CASCADE;--> statement-breakpoint
ALTER TABLE "core"."risk_assessments" DROP COLUMN "model_score";--> statement-breakpoint
ALTER TABLE "core"."risk_labels" DROP COLUMN "features";