-- ⚠ A LOCK TIMEOUT FIRST. `REVOKE ALL` takes ACCESS EXCLUSIVE briefly on the
-- brand-new empty `authd.mail_device_enrollments` table; `VALIDATE CONSTRAINT`
-- takes SHARE UPDATE EXCLUSIVE on `authd.mail_device_cert_permits` (allows
-- concurrent reads and writes, and scans at most a handful of operator probe
-- rows since no SCEP permits exist before PR 4). Five seconds, then fail and
-- retry.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- Enrollments are short-lived and churny (created, attested, sealed, deleted a
-- day past expiry by retention); vacuum aggressively so dead tuples stay low.
ALTER TABLE "authd"."mail_device_enrollments" SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 1000
);
--> statement-breakpoint

-- ⚠ ENROLLMENTS ARE THE API'S ALONE. Schema default privileges (20260901120426)
-- grant `authd` SELECT on every new table in `authd`; enrollment tokens,
-- attested attributes and sealed profiles are never read by `authd` or
-- `mailfront`. `i10_api` keeps DML through its own default privileges
-- (20260901170445). Grant tests assert that neither `authd` nor `mailfront`
-- has any privilege on this table.
REVOKE ALL ON "authd"."mail_device_enrollments" FROM authd, mailfront;
--> statement-breakpoint

-- Validate the two constraints added NOT VALID to `authd.mail_device_cert_permits`
-- in the previous migration. Production has zero SCEP permits prior to PR 4
-- (only operator-made ACME probe permits exist), so every existing row has
-- `kind = 'acme'` and `enrollment_id IS NULL`.
ALTER TABLE "authd"."mail_device_cert_permits"
  VALIDATE CONSTRAINT "mail_device_cert_permits_enrollment_fk";
--> statement-breakpoint
ALTER TABLE "authd"."mail_device_cert_permits"
  VALIDATE CONSTRAINT "mail_device_cert_permits_enrollment_kind";
