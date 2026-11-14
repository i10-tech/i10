-- The trained model and behaviour similarity are gone (docs/decisions/risk.md).
--
-- ⚠ THE DEFINERS GO BEFORE THEIR TABLES. They read `risk_models`,
-- `behaviour_vectors` and `risk_labels.features`, which the next migration
-- drops; a SQL function body is not a tracked dependency, so Postgres would let
-- them outlive the tables and fail only when called.
--
-- `core.risk_labels` stays: labels are the ground truth the rules are measured
-- against. Only the training reads of it are dropped.
DROP FUNCTION "core"."behaviour_neighbors"(uuid, integer);
--> statement-breakpoint
DROP FUNCTION "core"."risk_training_rows"();
--> statement-breakpoint
DROP FUNCTION "core"."risk_label_count"();
--> statement-breakpoint
DROP FUNCTION "core"."risk_model_get"(boolean);
--> statement-breakpoint
DROP FUNCTION "core"."risk_model_save"(jsonb, jsonb, boolean);
