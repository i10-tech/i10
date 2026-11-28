-- Lock and read the gate inputs of a batch of accounts for `enroll_writer`.
--
-- ⚠ CORRECTS THE PREVIOUS MIGRATION'S COMMENT. 20261127203951 says `FOR SHARE`
-- on `authd.accounts` needs SELECT only. It does not: every row-locking clause
-- (`FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`) needs UPDATE
-- privilege on at least one column of the locked table (PostgreSQL docs,
-- SELECT, "The Locking Clause"). Measured against PG 18: `enroll_writer`'s
-- `SELECT ... FOR SHARE` failed with 42501, so no mint and no Mac bind could
-- commit. That migration is applied and cannot change, so the fix lives here.
--
-- ⚠ THE LOCK GOES THROUGH THIS FUNCTION SO `enroll_writer` NEVER GETS UPDATE ON
-- `authd.accounts`. It runs as its owner, which may lock the rows; a row lock
-- taken inside a function belongs to the calling transaction, so the batcher
-- holds every account it read until its own COMMIT, exactly as a direct
-- `FOR SHARE` would. The lock is SHARE: it blocks every UPDATE and DELETE of the
-- account (a suspension, a deletion, an epoch bump) until the mint commits, and
-- two batches may hold it on one account at once.
--
-- ⚠ CALLED ONCE PER BATCH WITH AN ARRAY, NEVER ONCE PER ROW. A SECURITY DEFINER
-- SQL function is never inlined (db-guard red flag); one call per batch of up to
-- 200 rows reads them by primary key (`clerk_user_id = ANY(...)`). The domain
-- gate (`core.mailbox_domain_refused`) stays outside, called once per distinct
-- (tenant, domain) of the batch by the batcher.
--
-- ⚠ THE COLUMNS ARE EXACTLY WHAT `lockAndLoadAccounts` (services/authd/internal/
-- enrollctl/batcher.go) SCANS, IN ORDER, WITH THE SAME EXPRESSIONS AS
-- projection.accountColumns uses for the bind. A change to one is a change to
-- the other in the same PR.
--
-- Not changed here, and fine as it is: the unique index on
-- `authd.mail_devices (enrollment_id)` from 20261127203950 is built without
-- CONCURRENTLY. The table is near-empty in production and that migration sets
-- `lock_timeout`, so the brief SHARE lock it takes cannot queue the deploy.
CREATE FUNCTION "authd"."enroll_lock_gate_accounts"(p_clerk_user_ids text[])
RETURNS TABLE (
  clerk_user_id text,
  email text,
  active boolean,
  tenant_id text,
  credential_epoch bigint,
  suspended boolean,
  payment_hold boolean,
  deleting boolean,
  banned boolean,
  locked boolean,
  mail_domain text,
  managed boolean,
  managed_connection text,
  connection_inactive boolean,
  sso_required boolean,
  sso_exempt boolean
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = authd, pg_temp
AS $$
  SELECT a.clerk_user_id,
         a.email,
         a.active,
         a.tenant_id::text,
         a.credential_epoch,
         (a.suspended_at IS NOT NULL),
         (a.payment_hold_at IS NOT NULL),
         (a.deleting_at IS NOT NULL),
         a.banned,
         (a.locked AND (a.locked_until IS NULL OR a.locked_until > now())),
         lower(split_part(a.email, '@', 2)),
         (m.clerk_user_id IS NOT NULL),
         m.connection_id::text,
         (pv.active IS FALSE),
         EXISTS (
           SELECT 1 FROM authd.required_domains rd
            WHERE rd.domain = lower(split_part(a.email, '@', 2))
              AND rd.tenant_id = a.tenant_id
         ),
         EXISTS (
           SELECT 1 FROM authd.required_domains rd
             JOIN authd.required_exempt ex
               ON ex.connection_id = rd.connection_id
              AND ex.tenant_id = rd.tenant_id
            WHERE rd.domain = lower(split_part(a.email, '@', 2))
              AND rd.tenant_id = a.tenant_id
              AND ex.clerk_user_id = a.clerk_user_id
         )
    FROM authd.accounts a
    LEFT JOIN authd.managed_accounts m ON m.clerk_user_id = a.clerk_user_id
    LEFT JOIN authd.passthrough_versions pv ON pv.connection_id = m.connection_id
   WHERE a.clerk_user_id = ANY(p_clerk_user_ids)
   ORDER BY a.clerk_user_id
     FOR SHARE OF a
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "authd"."enroll_lock_gate_accounts"(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "authd"."enroll_lock_gate_accounts"(text[]) TO enroll_writer;
