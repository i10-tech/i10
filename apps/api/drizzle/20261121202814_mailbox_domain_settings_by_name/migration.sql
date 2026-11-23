-- `core.mailbox_domain_settings(p_name)` reads one name's rows, not every row.
--
-- ⚠ THE SAME FUNCTION, ONE MORE PREDICATE, AND NOTHING ELSE CHANGES. With a name
-- it used to join EVERY row of `core.domains` to `name_holders(p_name)` and let
-- the join throw the rest away: a scan of the whole table on each call, about
-- 14 ms at 20,000 domains. It is called once per authd bind (through
-- `core.mailbox_domain_refused`) and, in the mail front's revocation sweep, once
-- per live domain every second, where that scan was the whole cost
-- (docs/research/mail-device-binding.md, section 9). Filtering `d` by the name
-- lets the planner use `domains_lower_name_idx`, from the migration before this
-- one. The answer is unchanged: the join already kept only rows whose
-- `lower(name)` is the one `name_holders(p_name)` returns, which is
-- `lower(p_name)`.
--
-- ⚠ `p_name IS NULL` STILL MEANS EVERY NAME, for `mailbox_domains()` and the
-- reconcile cron. `CREATE OR REPLACE` keeps the function's grants.
CREATE OR REPLACE FUNCTION "core"."mailbox_domain_settings"(p_name text DEFAULT NULL)
RETURNS TABLE (
  name text,
  tenant_id uuid,
  catch_all_address text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.name, d.tenant_id, d.catch_all_address
    FROM core.domains d
    JOIN core.name_holders(p_name) h
      ON h.name = lower(d.name) AND h.tenant_id = d.tenant_id
   WHERE d.hosts_mailboxes
     AND d.displaced_at IS NULL
     AND (p_name IS NULL OR lower(d.name) = lower(p_name))
$$;
