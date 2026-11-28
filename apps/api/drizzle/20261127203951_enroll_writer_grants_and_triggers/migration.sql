-- ⚠ A LOCK TIMEOUT FIRST. Replacing the triggers on `authd.mail_devices` takes
-- SHARE ROW EXCLUSIVE briefly; five seconds, then fail and retry. Nothing here
-- scans a table.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- ⚠ IGNORE `enrollment_id` AND `acme_bound_at` IN THE ACCESS-CHANGE TRIGGERS.
-- Neither column is read by the mail front's gate query; `authd.log_access_change`
-- reads its ignored column list from `TG_ARGV[2:]`, and
-- `TestEveryTableTheGateReadsLogsItsChanges` verifies every ignored column exists
-- on the table and is absent from the gate's SQL. `CREATE OR REPLACE TRIGGER`
-- swaps each trigger in place without leaving an unlogged window.
CREATE OR REPLACE TRIGGER "access_changes_ins" AFTER INSERT ON "authd"."mail_devices"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id',
    'first_used_at', 'last_used_at', 'device_name', 'model', 'serial', 'created_by',
    'enrollment_id', 'acme_bound_at');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "access_changes_upd" AFTER UPDATE ON "authd"."mail_devices"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id',
    'first_used_at', 'last_used_at', 'device_name', 'model', 'serial', 'created_by',
    'enrollment_id', 'acme_bound_at');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "access_changes_del" AFTER DELETE ON "authd"."mail_devices"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id',
    'first_used_at', 'last_used_at', 'device_name', 'model', 'serial', 'created_by',
    'enrollment_id', 'acme_bound_at');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "access_changes_trunc" AFTER TRUNCATE ON "authd"."mail_devices"
  FOR EACH STATEMENT EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id');
--> statement-breakpoint

-- Least privilege for `enroll_writer`, the role `enrollctl`'s micro-batcher
-- connects as through PgBouncer (docs/research/enrollment-at-scale.md).
--
-- ⚠ THE ROLE IS CREATED BY CNPG (`managed.roles` in
-- infra/k8s/i10/platform-db/cluster.yaml) AND MUST EXIST BEFORE THIS RUNS.
-- Deliberately unguarded so a missing role fails the PreSync migration hook
-- loudly rather than leaving `enroll_writer` without grants.
--
-- ⚠ NO DEFAULT PRIVILEGES AND NO ACCESS TO `core.*` TABLES OR `identity.*`.
-- `enroll_writer` reads the gate inputs (`FOR SHARE` on `authd.accounts`, which
-- requires SELECT only and still blocks concurrent UPDATE/DELETE revocations),
-- calls `core.mailbox_domain_refused`, inserts newly minted `authd.mail_devices`
-- rows, updates only the four Mac ACME bind columns on `authd.mail_devices`,
-- and deletes stale liveness rows from `authd.mail_device_cert_binds` (with
-- column-level SELECT on `device_id` only, required by PostgreSQL for the
-- `DELETE ... WHERE device_id = ANY($1)` filter).
GRANT CONNECT ON DATABASE i10 TO enroll_writer;
--> statement-breakpoint
GRANT USAGE ON SCHEMA authd TO enroll_writer;
--> statement-breakpoint
GRANT USAGE ON SCHEMA core TO enroll_writer;
--> statement-breakpoint
GRANT SELECT ON
  "authd"."accounts",
  "authd"."managed_accounts",
  "authd"."passthrough_versions",
  "authd"."required_domains",
  "authd"."required_exempt",
  "authd"."mail_devices"
  TO enroll_writer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."mailbox_domain_refused"(uuid, text) TO enroll_writer;
--> statement-breakpoint
GRANT INSERT ON "authd"."mail_devices" TO enroll_writer;
--> statement-breakpoint
GRANT UPDATE ("cert_key_sha256", "first_used_at", "last_used_at", "acme_bound_at")
  ON "authd"."mail_devices" TO enroll_writer;
--> statement-breakpoint
GRANT SELECT ("device_id"), DELETE ON "authd"."mail_device_cert_binds" TO enroll_writer;
