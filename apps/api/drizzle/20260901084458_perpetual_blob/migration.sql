CREATE SCHEMA "authd";
--> statement-breakpoint
CREATE TABLE "authd"."accounts" (
	"clerk_user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"description" text,
	"active" boolean DEFAULT false NOT NULL,
	"clerk_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "authd"."aliases" (
	"address" text PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authd"."group_members" (
	"group_name" text NOT NULL,
	"clerk_user_id" text NOT NULL,
	CONSTRAINT "group_members_group_name_clerk_user_id_pk" PRIMARY KEY("group_name","clerk_user_id")
);
--> statement-breakpoint
CREATE TABLE "authd"."groups" (
	"name" text PRIMARY KEY NOT NULL,
	"email" text,
	"description" text,
	CONSTRAINT "groups_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "authd"."webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authd"."aliases" ADD CONSTRAINT "aliases_clerk_user_id_accounts_clerk_user_id_fk" FOREIGN KEY ("clerk_user_id") REFERENCES "authd"."accounts"("clerk_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authd"."group_members" ADD CONSTRAINT "group_members_group_name_groups_name_fk" FOREIGN KEY ("group_name") REFERENCES "authd"."groups"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authd"."group_members" ADD CONSTRAINT "group_members_clerk_user_id_accounts_clerk_user_id_fk" FOREIGN KEY ("clerk_user_id") REFERENCES "authd"."accounts"("clerk_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aliases_account_idx" ON "authd"."aliases" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "group_members_account_idx" ON "authd"."group_members" USING btree ("clerk_user_id");