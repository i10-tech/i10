ALTER TYPE "core"."webhook_endpoint_kind" ADD VALUE 'sqs';--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "aws_access_key_id" text;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "aws_secret_ciphertext" text;