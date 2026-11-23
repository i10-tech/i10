-- ⚠ A LOCK TIMEOUT FIRST. The foreign key takes a SHARE ROW EXCLUSIVE lock on
-- `identity.connections`, which waits behind any open writer of it and blocks
-- writes while it waits. Five seconds and it fails (the Job retries) instead of
-- stalling every connection write (PostgreSQL docs, 13.3.1 "Table-Level Locks").
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "authd"."passthrough_versions" (
	"connection_id" uuid PRIMARY KEY,
	"version" bigint NOT NULL,
	"fingerprint" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authd"."passthrough_versions" ADD CONSTRAINT "authd_passthrough_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "identity"."connections"("id") ON DELETE CASCADE;