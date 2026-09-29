-- Retention, attachment storage and the sweeps behind them (#136, #168, #188).
-- The design is docs/decisions/storage.md.
--
-- ⚠ EVERY FUNCTION HERE RETURNS IDS AND NUMBERS, NEVER CONTENT. They exist so
-- a job running as `i10_api` can find which workspaces have work without a
-- role that reads every tenant's mail; the work itself then runs per tenant,
-- under RLS, through `withTenant`.

-- The catalogue's periods: Free 3 days, Pro 30 (the column default).
-- ⚠ ONLY WHILE STILL AT THE DEFAULT, so a period somebody set deliberately
-- before this ran is not reverted - the same rule as 0012's DO NOTHING.
UPDATE core.plans SET retention_days = 3 WHERE id = 'free' AND retention_days = 30;
--> statement-breakpoint

-- Workspaces holding mail older than their plan allows, and that period.
--
-- ⚠ `p_floor_days` IS THE BILLING RECONCILE'S LOOKBACK PLUS ONE, passed in by
-- the job. The reconcile counts `core.messages` against the meter over that
-- window, so no period may reach inside it whatever a plan says.
--
-- ⚠ A WORKSPACE WITH NO ASSIGNMENT - a deleted tenant's leftover mail, the
-- rows a flush leaves behind - takes the free plan's period. Its mail must
-- still expire; the free period is the shortest honest answer.
--
-- ⚠ BODIES ARE COUNTED AS WELL AS MESSAGES. A body whose message row is
-- already gone is exactly the leftover a flush produces, and it must still
-- age out.
CREATE FUNCTION "core"."retention_due"(p_floor_days integer)
RETURNS TABLE (tenant_id uuid, retention_days integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH oldest AS (
    SELECT o.tenant_id, min(o.created_at) AS oldest
      FROM (
        SELECT m.tenant_id, min(m.created_at) AS created_at
          FROM core.messages m GROUP BY m.tenant_id
        UNION ALL
        SELECT b.tenant_id, min(b.created_at)
          FROM core.message_bodies b GROUP BY b.tenant_id
      ) o
     GROUP BY o.tenant_id
  ), policy AS (
    SELECT x.tenant_id, x.oldest,
           greatest(
             p_floor_days,
             coalesce(p.retention_days, f.retention_days, 30)
           ) AS days
      FROM oldest x
      LEFT JOIN core.plan_assignments a ON a.tenant_id = x.tenant_id
      LEFT JOIN core.plans p ON p.id = a.plan_id
      LEFT JOIN core.plans f ON f.id = 'free'
  )
  SELECT tenant_id, days
    FROM policy
   WHERE oldest < now() - make_interval(days => days)
$$;
--> statement-breakpoint

-- Who a message belonged to, after retention deleted it: the tombstone the
-- SES and Stalwart event paths fall back to, so a late complaint still
-- suppresses its address. See `core.expired_messages`.
CREATE FUNCTION "core"."expired_message_owner"(p_message_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT e.tenant_id FROM core.expired_messages e WHERE e.message_id = p_message_id
$$;
--> statement-breakpoint

-- Workspaces with files still waiting to move to R2. The partial index on
-- `message_bodies` makes this a walk over pending rows only.
CREATE FUNCTION "core"."content_store_due"(p_limit integer)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT DISTINCT b.tenant_id
    FROM core.message_bodies b
   WHERE b.attachments IS NOT NULL
     AND b.attachments_stored_at IS NULL
   LIMIT p_limit
$$;
--> statement-breakpoint

-- Workspaces with objects or templates nobody has wanted for `p_grace`: the
-- only ones the sweeps need to look at.
CREATE FUNCTION "core"."content_sweep_due"(p_grace interval)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT o.tenant_id FROM core.content_objects o
   WHERE o.last_seen_at < now() - p_grace
  UNION
  SELECT t.tenant_id FROM core.content_templates t
   WHERE t.last_seen_at < now() - p_grace
$$;
--> statement-breakpoint

-- Tombstones older than `p_keep`, across every workspace. Ids only ever left
-- this table through `expired_message_owner`, so there is nothing to scope.
CREATE FUNCTION "core"."prune_expired_messages"(p_keep interval, p_limit integer)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH gone AS (
    DELETE FROM core.expired_messages
     WHERE message_id IN (
       SELECT e.message_id FROM core.expired_messages e
        WHERE e.expired_at < now() - p_keep
        LIMIT p_limit
     )
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone
$$;
--> statement-breakpoint

-- Monthly partitions for the next `p_months` months, locked down as 0064 left
-- every other one.
--
-- ⚠ 0002 CREATED A YEAR OF THEM AND NOTHING EVER EXTENDED IT. From the first
-- month past that year every row would land in the DEFAULT partition, which
-- then blocks creating the real one. The retention job calls this every run,
-- so the window never closes.
--
-- ⚠ RLS AND THE REVOKE ON EVERY NEW PARTITION. A partition is a plain table a
-- direct query reaches around the parent's policy; 0064 closed that for the
-- ones that existed, and this must not reopen it for the ones that follow.
CREATE FUNCTION "core"."ensure_message_partitions"(p_months integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  tbl text;
  m date;
  part text;
  created integer := 0;
  start_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['messages', 'message_bodies', 'message_events'] LOOP
    FOR i IN 0..greatest(p_months, 1) LOOP
      m := (start_month + (i || ' months')::interval)::date;
      part := tbl || '_' || to_char(m, 'YYYY_MM');
      CONTINUE WHEN to_regclass('core.' || quote_ident(part)) IS NOT NULL;
      EXECUTE format(
        'CREATE TABLE core.%I PARTITION OF core.%I FOR VALUES FROM (%L) TO (%L)',
        part,
        tbl,
        to_char(m, 'YYYY-MM-DD') || ' 00:00:00+00',
        to_char((m + interval '1 month')::date, 'YYYY-MM-DD') || ' 00:00:00+00'
      );
      EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', part);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON core.%I '
        'USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)',
        part
      );
      EXECUTE format('REVOKE ALL ON core.%I FROM i10_api', part);
      created := created + 1;
    END LOOP;
  END LOOP;
  RETURN created;
END
$$;
--> statement-breakpoint

-- Drops monthly partitions that ended longer ago than the LONGEST period any
-- plan has (never less than `p_floor_days`) AND are empty. Returns what it
-- dropped, and what it refused.
--
-- ⚠ EMPTY ONLY, AND THAT IS THE WHOLE SAFETY. Retention deletes per workspace
-- and writes a tombstone for each message as it goes; a partition dropped with
-- rows still in it would skip both, silently. So the per-tenant job is what
-- enforces retention, and this only takes away the empty shells it leaves -
-- a partition still holding rows past every plan's period is reported, never
-- dropped, because it means the job is failing somewhere.
CREATE FUNCTION "core"."drop_empty_message_partitions"(p_floor_days integer)
RETURNS TABLE (partition_name text, dropped boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  r record;
  upper_bound date;
  has_rows boolean;
  keep_days integer := greatest(
    p_floor_days,
    coalesce((SELECT max(pl.retention_days) FROM core.plans pl), 0)
  );
BEGIN
  FOR r IN
    SELECT c.relname AS name, p.relname AS parent
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = p.relnamespace
     WHERE n.nspname = 'core'
       AND p.relname IN ('messages', 'message_bodies', 'message_events')
       AND c.relname ~ '_[0-9]{4}_[0-9]{2}$'
  LOOP
    upper_bound := (to_date(right(r.name, 7), 'YYYY_MM') + interval '1 month')::date;
    CONTINUE WHEN upper_bound > (now() - make_interval(days => keep_days))::date;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM core.%I)', r.name) INTO has_rows;
    IF has_rows THEN
      partition_name := r.name;
      dropped := false;
      RETURN NEXT;
    ELSE
      EXECUTE format('DROP TABLE core.%I', r.name);
      partition_name := r.name;
      dropped := true;
      RETURN NEXT;
    END IF;
  END LOOP;
END
$$;
