ALTER TABLE "core"."member_invitations" ADD COLUMN "applied_membership_id" text;--> statement-breakpoint
ALTER TABLE "core"."member_invitations" ADD COLUMN "applied_at" timestamp with time zone;