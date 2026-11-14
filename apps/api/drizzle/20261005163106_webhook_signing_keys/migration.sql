CREATE TYPE "core"."webhook_signature_scheme" AS ENUM('hmac_sha256', 'ed25519');--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "signature_scheme" "core"."webhook_signature_scheme" DEFAULT 'hmac_sha256' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "public_key" text;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "retiring_secrets" jsonb DEFAULT '[]'::jsonb NOT NULL;