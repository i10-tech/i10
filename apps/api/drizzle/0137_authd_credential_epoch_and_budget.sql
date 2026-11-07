CREATE TABLE "authd"."bind_failure_budget" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authd"."accounts" ADD COLUMN "credential_epoch" bigint DEFAULT 0 NOT NULL;