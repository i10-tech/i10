CREATE TABLE "authd"."group_sent_copies" (
	"group_name" text NOT NULL,
	"message_id" text NOT NULL,
	"copied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_sent_copies_group_name_message_id_pk" PRIMARY KEY("group_name","message_id")
);
--> statement-breakpoint
ALTER TABLE "authd"."groups" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "authd"."groups" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "authd"."group_sent_copies" ADD CONSTRAINT "group_sent_copies_group_name_groups_name_fk" FOREIGN KEY ("group_name") REFERENCES "authd"."groups"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "groups_tenant_idx" ON "authd"."groups" USING btree ("tenant_id");