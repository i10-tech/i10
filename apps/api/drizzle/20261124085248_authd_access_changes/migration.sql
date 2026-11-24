-- ⚠ A LOCK TIMEOUT FIRST, as every migration here starts. This one only creates
-- a table, which waits on nothing, but every pending migration runs in one
-- transaction, and the next one (`*_access_change_triggers`) locks the gate's
-- tables. Five seconds and the batch fails (the Job retries) instead of queueing.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "authd"."access_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "authd"."access_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"txid" xid8 DEFAULT pg_current_xact_id() NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_changes_kind_check" CHECK ("kind" in ('account', 'domain', 'connection', 'all'))
);
--> statement-breakpoint
CREATE INDEX "access_changes_txid_idx" ON "authd"."access_changes" ("txid");