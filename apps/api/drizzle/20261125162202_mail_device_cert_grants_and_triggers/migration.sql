-- ⚠ A LOCK TIMEOUT FIRST. The trigger replacements take SHARE ROW EXCLUSIVE on
-- `authd.mail_devices`, and the batch this runs in also holds the previous
-- migration's locks on `authd.mail_devices` and `authd.accounts`; five seconds,
-- then fail and retry. Nothing here scans a table.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- Room on each page for authd's refresh of `bound_at` (at most once every five
-- minutes per row): `bound_at` is indexed, so the update is never HOT, and this
-- only keeps the new version on the same page. Set while the table is empty: no
-- rewrite.
ALTER TABLE "authd"."mail_device_cert_binds" SET (fillfactor = 80);
--> statement-breakpoint

-- ⚠ PERMITS ARE THE API'S ALONE. The schema's default privileges
-- (20260901120426) give `authd` SELECT on every new `authd` table; a permit's
-- serial, nonce hash and challenge hash are what a forged webhook body would
-- need, and neither authd nor the front ever reads one. REVOKE ALL, from both,
-- so a later grant elsewhere cannot widen it unseen: TestTheDeviceTableGrants
-- asserts that neither role can read the table. `mailfront` has no default
-- privileges (20261121202840), so its REVOKE only states the rule. The API keeps
-- DML through its own default privileges (20260901170445).
REVOKE ALL ON "authd"."mail_device_cert_permits" FROM authd, mailfront;
--> statement-breakpoint

-- authd keeps the liveness rows (docs/research/mail-device-binding.md section
-- 11): an upsert per certificate-verified IMAP bind of a Mac, at most once every
-- five minutes per row, and the per-device cap of eight rows, which deletes the
-- oldest. SELECT is also in the defaults; written out so the grant reads whole.
-- The API (default DML) deletes them with a key change and prunes them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "authd"."mail_device_cert_binds" TO authd;
--> statement-breakpoint

-- ⚠ THE MAIL FRONT READS ONE MORE COLUMN AND THE LIVENESS ROWS, AND WRITES
-- NOTHING. The device's key: `AUTHENTICATE EXTERNAL` reads the row by it, and the
-- re-check closes a certificate session whose key is no longer the row's. The
-- liveness rows: the front answers a Mac's SMTP AUTH `454` itself when there is
-- none, because Stalwart would turn authd's `unavailable` into a permanent 535.
-- A column grant beside 20261124231146's five, so the code's hash stays hidden.
GRANT SELECT ("cert_key_sha256") ON "authd"."mail_devices" TO mailfront;
--> statement-breakpoint
GRANT SELECT ON "authd"."mail_device_cert_binds" TO mailfront;
--> statement-breakpoint

-- ⚠ THE KEY IS AN ACCESS INPUT NOW, SO ITS CHANGES ARE LOGGED. 20261124231146
-- ignored `cert_sha256` while nothing read it. Binding, changing or clearing
-- `cert_key_sha256` now names the person, and the front's next poll re-checks
-- that person's connections: a certificate session whose key moved, and every
-- session of a `macos` row left with no key, are closed. ⚠ The rename does not
-- touch the triggers' arguments (they are text): after it they ignore
-- `cert_sha256`, a column that no longer exists, which watches the key only by
-- accident and fails TestEveryTableTheGateReadsLogsItsChanges. These replace all
-- four triggers with the list as meant, with no dead name in it.
--
-- CREATE OR REPLACE, not DROP then CREATE: each trigger is swapped in one
-- statement, so there is never a moment, even inside this transaction, when a
-- write to the table would go unlogged, and it takes SHARE ROW EXCLUSIVE rather
-- than DROP TRIGGER's ACCESS EXCLUSIVE.
CREATE OR REPLACE TRIGGER "access_changes_ins" AFTER INSERT ON "authd"."mail_devices"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id',
    'first_used_at', 'last_used_at', 'device_name', 'model', 'serial', 'created_by');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "access_changes_upd" AFTER UPDATE ON "authd"."mail_devices"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id',
    'first_used_at', 'last_used_at', 'device_name', 'model', 'serial', 'created_by');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "access_changes_del" AFTER DELETE ON "authd"."mail_devices"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id',
    'first_used_at', 'last_used_at', 'device_name', 'model', 'serial', 'created_by');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "access_changes_trunc" AFTER TRUNCATE ON "authd"."mail_devices"
  FOR EACH STATEMENT EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id');

-- The two new tables get no access-change triggers. Neither gates an open
-- session by itself: a permit only decides an issuance, and a liveness row only
-- a new SMTP bind. What closes sessions is the key on the device row (logged
-- above), and a deleted device takes both tables' rows by cascade, which its own
-- DELETE trigger logs.
