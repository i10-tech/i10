-- Adding a column with a constant default in Postgres 18 is metadata-only
-- (brief ACCESS EXCLUSIVE lock on identity.workspace_settings, no rewrite).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TYPE "identity"."auto_forwarding_mode" AS ENUM('workspace', 'workspace_and_members', 'anywhere', 'off');--> statement-breakpoint
CREATE TABLE "authd"."user_emails" (
	"clerk_user_id" text,
	"email" text,
	"clerk_updated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_emails_pkey" PRIMARY KEY("clerk_user_id","email"),
	CONSTRAINT "user_emails_email_lowercase" CHECK ("email" = lower("email"))
);
--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "auto_forwarding" "identity"."auto_forwarding_mode" DEFAULT 'workspace'::"identity"."auto_forwarding_mode" NOT NULL;--> statement-breakpoint
CREATE INDEX "user_emails_email_idx" ON "authd"."user_emails" ("email");