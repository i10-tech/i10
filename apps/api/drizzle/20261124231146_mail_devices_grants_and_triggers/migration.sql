-- ⚠ A LOCK TIMEOUT FIRST. CREATE TRIGGER and the grants lock only the new, empty
-- `authd.mail_devices`, but the batch this runs in also holds the previous
-- migration's lock on `authd.accounts`; five seconds, then fail and retry.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- Room on each page for the two stamps authd writes (`first_used_at` once,
-- `last_used_at` at most once a day). Neither update is HOT, because both columns
-- are in a partial index's predicate or key (the prune's), so this only keeps
-- the new versions on the same page. Set while the table is empty: no rewrite.
ALTER TABLE "authd"."mail_devices" SET (fillfactor = 85);
--> statement-breakpoint

-- authd reads every column through the schema's default privileges
-- (20260901120426) and may write exactly the two clock stamps of the device
-- lane, nothing else: never the code's hash, the person, the address, the
-- workspace or the platform. The API gets DML through its default privileges
-- (20260901170445).
GRANT UPDATE ("first_used_at", "last_used_at") ON "authd"."mail_devices" TO authd;
--> statement-breakpoint

-- ⚠ THE MAIL FRONT READS FIVE COLUMNS, BY NAME. It matches an open device
-- session's row to its account (gate.DeviceRefusal): the id, the person, the
-- address, the workspace and the platform. Never the code's hash or key id, the
-- serial, the model, the name or who created it. A column grant, not a table
-- grant, so a column added later is invisible to it until granted here, and no
-- default privileges, as for the rest of its grants (20261121202840).
GRANT SELECT ("id", "clerk_user_id", "email", "tenant_id", "platform") ON "authd"."mail_devices" TO mailfront;
--> statement-breakpoint

-- The access-change log (20261124085257): a device deleted, re-pointed, or
-- re-addressed names its person, and the front's next poll re-checks that
-- person's open connections, closing a device session whose row is gone or no
-- longer matches. Ignored: the clock stamps authd writes on sign-ins (the front's
-- re-check never reads them, they are bind rules) and the descriptive columns.
-- `cert_sha256` is ignored until PR 3 makes the front read it. `device_name` and
-- not `name`, because `name` is a word the gate's SQL uses for domains, and
-- TestEveryTableTheGateReadsLogsItsChanges refuses an ignored column the gate
-- names.
CREATE TRIGGER "access_changes_ins" AFTER INSERT ON "authd"."mail_devices"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id',
    'first_used_at', 'last_used_at', 'device_name', 'model', 'serial', 'created_by', 'cert_sha256');
--> statement-breakpoint
CREATE TRIGGER "access_changes_upd" AFTER UPDATE ON "authd"."mail_devices"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id',
    'first_used_at', 'last_used_at', 'device_name', 'model', 'serial', 'created_by', 'cert_sha256');
--> statement-breakpoint
CREATE TRIGGER "access_changes_del" AFTER DELETE ON "authd"."mail_devices"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id',
    'first_used_at', 'last_used_at', 'device_name', 'model', 'serial', 'created_by', 'cert_sha256');
--> statement-breakpoint
CREATE TRIGGER "access_changes_trunc" AFTER TRUNCATE ON "authd"."mail_devices"
  FOR EACH STATEMENT EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id');
