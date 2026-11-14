CREATE TABLE "core"."device_resumes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"resumed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."device_resumes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."remembered_devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"previous_secret_hash" text,
	"rotated_at" timestamp with time zone,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "remembered_devices_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
ALTER TABLE "core"."remembered_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."device_resumes" ADD CONSTRAINT "device_resumes_device_id_remembered_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "core"."remembered_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_resumes_user_idx" ON "core"."device_resumes" USING btree ("user_id","resumed_at");--> statement-breakpoint
CREATE INDEX "remembered_devices_user_idx" ON "core"."remembered_devices" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "device_resumes_scope" ON "core"."device_resumes" AS PERMISSIVE FOR ALL TO public USING ("core"."device_resumes"."user_id" = current_setting('app.user_id', true)) WITH CHECK ("core"."device_resumes"."user_id" = current_setting('app.user_id', true));--> statement-breakpoint
CREATE POLICY "remembered_devices_scope" ON "core"."remembered_devices" AS PERMISSIVE FOR ALL TO public USING ("core"."remembered_devices"."id"::text = current_setting('app.device_id', true) or "core"."remembered_devices"."user_id" = current_setting('app.user_id', true)) WITH CHECK ("core"."remembered_devices"."id"::text = current_setting('app.device_id', true) or "core"."remembered_devices"."user_id" = current_setting('app.user_id', true));