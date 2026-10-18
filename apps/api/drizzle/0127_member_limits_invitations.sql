CREATE TABLE "core"."member_alerts" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"alerted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."member_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."member_invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clerk_org_id" text NOT NULL,
	"clerk_invitation_id" text,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"inviter_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"zone" text NOT NULL,
	"country" text,
	"action_url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "core"."member_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."plans" ADD COLUMN "member_limit" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."member_alerts" ADD CONSTRAINT "member_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."member_invitations" ADD CONSTRAINT "member_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_invitations_tenant_idx" ON "core"."member_invitations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "member_invitations_email_idx" ON "core"."member_invitations" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "member_invitations_clerk_unique" ON "core"."member_invitations" USING btree ("clerk_invitation_id");--> statement-breakpoint
CREATE POLICY "member_alerts_workspace" ON "core"."member_alerts" AS PERMISSIVE FOR ALL TO public USING ("core"."member_alerts"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."member_alerts"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "member_invitations_workspace" ON "core"."member_invitations" AS PERMISSIVE FOR ALL TO public USING ("core"."member_invitations"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."member_invitations"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "member_invitations_invitee_read" ON "core"."member_invitations" AS PERMISSIVE FOR SELECT TO public USING ("core"."member_invitations"."email" = nullif(current_setting('app.invitee_email', true), ''));--> statement-breakpoint
CREATE POLICY "member_invitations_invitee_link" ON "core"."member_invitations" AS PERMISSIVE FOR UPDATE TO public USING ("core"."member_invitations"."email" = nullif(current_setting('app.invitee_email', true), '')) WITH CHECK ("core"."member_invitations"."email" = nullif(current_setting('app.invitee_email', true), ''));--> statement-breakpoint
CREATE POLICY "member_invitations_link_read" ON "core"."member_invitations" AS PERMISSIVE FOR SELECT TO public USING ("core"."member_invitations"."id"::text = nullif(current_setting('app.invitation_id', true), ''));