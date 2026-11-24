-- ⚠ A LOCK TIMEOUT FIRST. CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on each
-- table below, `authd.accounts` and `core.domains` among them, which waits behind
-- any open writer and blocks every later write while it waits. Five seconds and
-- the batch fails (the Job retries) instead of stalling sign-ins and domain
-- writes (PostgreSQL docs, 13.3.1 "Table-Level Locks"). Each lock is held only
-- until the deploy's batch commits: nothing here scans or rewrites a table.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- The access-change log's writers: one trigger function, fired once per
-- STATEMENT on every table the mail gate reads (services/authd/internal/gate,
-- through projection.accountColumns and the `core` functions it calls). The mail
-- front reads the log each second and re-checks only the open connections it
-- names (services/authd README, "The sweep").
--
-- ⚠ EVERY TABLE THE GATE READS, EVERY WAY IT CAN CHANGE. A table it reads with
-- no trigger is a revocation that waits for the once-a-minute backstop, so
-- `TestEveryTableTheGateReadsLogsItsChanges` (services/authd/internal/projection)
-- derives the tables from the gate's own SQL and fails until each has all four
-- triggers. INSERT, UPDATE and DELETE are logged (foreign key cascades fire them
-- too, which is how a workspace or mailbox deleted reaches the log), and
-- TRUNCATE logs `all`, which makes the front sweep everything.
--
-- ⚠ STATEMENT TRIGGERS WITH TRANSITION TABLES. A bulk update of 10,000 accounts
-- is one trigger call and one INSERT of its distinct keys, not 10,000 calls.
--
-- ⚠ AN UPDATE LOGS BOTH THE OLD AND THE NEW KEY of every row that changed, so
-- an address or a domain name that moves is re-checked under both.
--
-- ⚠ AN UPDATE THAT CHANGES ONLY IGNORED COLUMNS LOGS NOTHING, and the ignored
-- columns are a deny-list, the trigger's arguments after the first two. A row is
-- compared as `to_jsonb(row) - <ignored>`, so a column added to a table later is
-- watched until somebody ignores it on purpose. A column may be ignored only if
-- no SQL the gate runs names it: the same test reads the arguments back from
-- the catalog and checks each against the gate's SQL text. Domains are rechecked
-- for DNS, RDAP and SES bookkeeping often, which is why ignoring is worth it.
--
-- ⚠ SECURITY DEFINER WITH A PINNED search_path, so every writer (`i10_api`, the
-- migrator, a cascade) fires it without any grant on the log, and no writer can
-- point it at another table. EXECUTE is checked when a trigger is created, not
-- when it fires, so it is revoked from everybody.
--
-- The arguments: the kind (`account`, `domain` or `connection`), the column
-- holding the key, then the ignored columns. A `domain` key is lowercased, as the
-- gate compares domains.
CREATE FUNCTION "authd"."log_access_change"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = authd, pg_temp
AS $$
DECLARE
  v_kind text := TG_ARGV[0];
  v_key text := TG_ARGV[1];
  v_ignored text[] := coalesce(TG_ARGV[2:], '{}');
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO authd.access_changes (kind, key) VALUES ('all', '');
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO authd.access_changes (kind, key)
    SELECT DISTINCT v_kind, CASE WHEN v_kind = 'domain' THEN lower(k) ELSE k END
      FROM (SELECT to_jsonb(n) ->> v_key AS k FROM new_rows n) s
     WHERE k IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO authd.access_changes (kind, key)
    SELECT DISTINCT v_kind, CASE WHEN v_kind = 'domain' THEN lower(k) ELSE k END
      FROM (SELECT to_jsonb(o) ->> v_key AS k FROM old_rows o) s
     WHERE k IS NOT NULL;
  ELSE
    -- The rows whose watched content is not in the other image: the old side of
    -- every changed row and the new side of every changed row. A row only some
    -- ignored column moved is in both images and drops out.
    INSERT INTO authd.access_changes (kind, key)
    SELECT DISTINCT v_kind, CASE WHEN v_kind = 'domain' THEN lower(k) ELSE k END
      FROM (
        SELECT c.j ->> v_key AS k
          FROM ((SELECT to_jsonb(o) - v_ignored AS j FROM old_rows o
                 EXCEPT
                 SELECT to_jsonb(n) - v_ignored FROM new_rows n)
                UNION ALL
                (SELECT to_jsonb(n) - v_ignored FROM new_rows n
                 EXCEPT
                 SELECT to_jsonb(o) - v_ignored FROM old_rows o)) c
      ) s
     WHERE k IS NOT NULL;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "authd"."log_access_change"() FROM PUBLIC;
--> statement-breakpoint

-- authd.accounts: every gate column is on it. `display_name` and `description`
-- are not gate inputs, but the bind's query names them, so they stay watched.
CREATE TRIGGER "access_changes_ins" AFTER INSERT ON "authd"."accounts"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id', 'storage_allocation', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_upd" AFTER UPDATE ON "authd"."accounts"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id', 'storage_allocation', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_del" AFTER DELETE ON "authd"."accounts"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id', 'storage_allocation', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_trunc" AFTER TRUNCATE ON "authd"."accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id');
--> statement-breakpoint

-- authd.managed_accounts: whether, and by which connection, an account is managed.
CREATE TRIGGER "access_changes_ins" AFTER INSERT ON "authd"."managed_accounts"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_upd" AFTER UPDATE ON "authd"."managed_accounts"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_del" AFTER DELETE ON "authd"."managed_accounts"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_trunc" AFTER TRUNCATE ON "authd"."managed_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id');
--> statement-breakpoint

-- authd.passthrough_versions: per connection. The gate does not refuse on the
-- version (its change also raises every managed account's epoch, which does),
-- but the bind's query reads it, so its changes are logged like any other input.
CREATE TRIGGER "access_changes_ins" AFTER INSERT ON "authd"."passthrough_versions"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('connection', 'connection_id', 'fingerprint', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_upd" AFTER UPDATE ON "authd"."passthrough_versions"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('connection', 'connection_id', 'fingerprint', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_del" AFTER DELETE ON "authd"."passthrough_versions"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('connection', 'connection_id', 'fingerprint', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_trunc" AFTER TRUNCATE ON "authd"."passthrough_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "authd"."log_access_change"('connection', 'connection_id');
--> statement-breakpoint

-- authd.required_domains: per domain (SSO required, and through which connection
-- the exemptions join).
CREATE TRIGGER "access_changes_ins" AFTER INSERT ON "authd"."required_domains"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('domain', 'domain', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_upd" AFTER UPDATE ON "authd"."required_domains"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('domain', 'domain', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_del" AFTER DELETE ON "authd"."required_domains"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('domain', 'domain', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_trunc" AFTER TRUNCATE ON "authd"."required_domains"
  FOR EACH STATEMENT EXECUTE FUNCTION "authd"."log_access_change"('domain', 'domain');
--> statement-breakpoint

-- authd.required_exempt: per person.
CREATE TRIGGER "access_changes_ins" AFTER INSERT ON "authd"."required_exempt"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_upd" AFTER UPDATE ON "authd"."required_exempt"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_del" AFTER DELETE ON "authd"."required_exempt"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_trunc" AFTER TRUNCATE ON "authd"."required_exempt"
  FOR EACH STATEMENT EXECUTE FUNCTION "authd"."log_access_change"('account', 'clerk_user_id');
--> statement-breakpoint

-- core.domains: per domain name, through core.mailbox_domain_refused,
-- core.mailbox_domain_settings and core.name_holders (20261110221547 and
-- 20261121202814). Ignored: sending, routing, tracking, DKIM, SES, onboarding and
-- check-time bookkeeping, none of which those functions read.
CREATE TRIGGER "access_changes_ins" AFTER INSERT ON "core"."domains"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('domain', 'name',
    'sends', 'receiving', 'mail_from_subdomain', 'transactional_route', 'delivery_route', 'mailbox_route',
    'delegated', 'delegation_token', 'open_tracking', 'click_tracking', 'dkim_selector', 'dkim_public_key',
    'dkim_private_key_sealed', 'ses_tenant_name', 'ses_tenant_layout', 'dns_checked_at', 'records_added_at',
    'registered_at', 'rdap_checked_at', 'onboarding_email_id', 'onboarding_email_to', 'onboarding_email_at',
    'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_upd" AFTER UPDATE ON "core"."domains"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('domain', 'name',
    'sends', 'receiving', 'mail_from_subdomain', 'transactional_route', 'delivery_route', 'mailbox_route',
    'delegated', 'delegation_token', 'open_tracking', 'click_tracking', 'dkim_selector', 'dkim_public_key',
    'dkim_private_key_sealed', 'ses_tenant_name', 'ses_tenant_layout', 'dns_checked_at', 'records_added_at',
    'registered_at', 'rdap_checked_at', 'onboarding_email_id', 'onboarding_email_to', 'onboarding_email_at',
    'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_del" AFTER DELETE ON "core"."domains"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('domain', 'name',
    'sends', 'receiving', 'mail_from_subdomain', 'transactional_route', 'delivery_route', 'mailbox_route',
    'delegated', 'delegation_token', 'open_tracking', 'click_tracking', 'dkim_selector', 'dkim_public_key',
    'dkim_private_key_sealed', 'ses_tenant_name', 'ses_tenant_layout', 'dns_checked_at', 'records_added_at',
    'registered_at', 'rdap_checked_at', 'onboarding_email_id', 'onboarding_email_to', 'onboarding_email_at',
    'updated_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_trunc" AFTER TRUNCATE ON "core"."domains"
  FOR EACH STATEMENT EXECUTE FUNCTION "authd"."log_access_change"('domain', 'name');
--> statement-breakpoint

-- core.join_domains: a TXT proof is a way to hold a name (core.name_holders).
-- Ignored: the join rules, the token and the re-check time.
CREATE TRIGGER "access_changes_ins" AFTER INSERT ON "core"."join_domains"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('domain', 'name', 'domain_id', 'clerk_org_id', 'token', 'rules', 'checked_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_upd" AFTER UPDATE ON "core"."join_domains"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('domain', 'name', 'domain_id', 'clerk_org_id', 'token', 'rules', 'checked_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_del" AFTER DELETE ON "core"."join_domains"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION "authd"."log_access_change"('domain', 'name', 'domain_id', 'clerk_org_id', 'token', 'rules', 'checked_at');
--> statement-breakpoint
CREATE TRIGGER "access_changes_trunc" AFTER TRUNCATE ON "core"."join_domains"
  FOR EACH STATEMENT EXECUTE FUNCTION "authd"."log_access_change"('domain', 'name');
--> statement-breakpoint

-- Pruning, from the hourly retention job (apps/api/src/retention.ts) as `i10_api`.
--
-- ⚠ THE CUTOFF IS FIXED HERE, AN HOUR, SO A BUG IN A CALLER CAN AT WORST DELETE
-- ROWS NO READER NEEDS. The front needs a row for about a second, and it sweeps
-- everything once a minute and after ten minutes without a successful read.
--
-- ⚠ BY id, BELOW THE OLDEST RECENT ROW IN THIS 10,000-ID WINDOW, NOT BY `at`
-- ACROSS THE WHOLE LOG. `low` is the smallest id in the table, and `edge` is
-- the smallest id of a row from the last hour inside `[low, low + 10000)`, or
-- `low + 10000` when none in that window is that recent. Bounding the search to
-- the current window keeps each call's cost proportional to one batch rather
-- than the whole backlog, with no index on `at`. A row with an old `at` above
-- the edge (a long transaction's) waits for a later call.
--
-- ⚠ A RANGE OF THE PRIMARY KEY, NOT A JOIN. Ids are unique, so `[low, edge)`
-- holds at most 10,000 rows, and the delete is one index range scan. A join to
-- a list of ids was planned as a hash join over a sequential scan of the whole
-- log (EXPLAIN on 687,041 rows: 94 ms). Gaps in the ids only make a call delete
-- fewer; it deletes nothing (returns 0) only when the table is empty or the
-- smallest remaining id is already inside the last hour, and the job calls
-- again until then.
CREATE FUNCTION "authd"."prune_access_changes"()
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = authd, pg_temp
AS $$
  WITH low AS (
    SELECT min(c.id) AS id FROM authd.access_changes c
  ), bounds AS (
    SELECT coalesce(
             (SELECT min(c.id) FROM authd.access_changes c
               WHERE c.id >= l.id AND c.id < l.id + 10000
                 AND c.at >= now() - interval '1 hour'),
             l.id + 10000
           ) AS edge
      FROM low l WHERE l.id IS NOT NULL
  ), gone AS (
    DELETE FROM authd.access_changes c USING bounds b
     WHERE c.id < b.edge
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "authd"."prune_access_changes"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "authd"."prune_access_changes"() TO i10_api;
--> statement-breakpoint

-- ⚠ ONLY THE TRIGGERS WRITE THE LOG AND ONLY THE PRUNE DELETES FROM IT. The
-- schema's default privileges gave `i10_api` every write and `authd` SELECT when
-- the table was created (20260901170445, 20260901120426); a row the API deleted
-- would be a revocation the front never re-checks until the backstop. The mail
-- front reads it, and that is all its role does (20261121202840).
REVOKE ALL ON "authd"."access_changes" FROM i10_api, authd;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE "authd"."access_changes_id_seq" FROM i10_api, authd;
--> statement-breakpoint
GRANT SELECT ON "authd"."access_changes" TO mailfront;
