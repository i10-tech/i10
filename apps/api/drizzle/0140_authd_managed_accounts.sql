CREATE TABLE "authd"."managed_accounts" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"connection_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authd"."managed_accounts" ADD CONSTRAINT "authd_managed_user_fk" FOREIGN KEY ("clerk_user_id") REFERENCES "identity"."managed_accounts"("clerk_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authd"."managed_accounts" ADD CONSTRAINT "authd_managed_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "identity"."connections"("id") ON DELETE set null ON UPDATE no action;