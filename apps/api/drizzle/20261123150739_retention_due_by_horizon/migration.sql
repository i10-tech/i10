SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- `core.retention_due` without reading every workspace's mail every hour (#507).
--
-- Before this, each hourly run took `min(created_at)` of every message and
-- every body in every partition: 680 ms and 1.98 GB on the scale seed, growing
-- with all mail kept. Now a workspace is looked at only when its cutoff has
-- passed `core.retention_horizons.oldest_at`, a time before which it holds no
-- mail. Looking is two index probes bounded by the cutoff (is there mail
-- before it?) and, when there is none, two more from the cutoff on (when is
-- the oldest?), so a workspace whose oldest mail is two days inside its period
-- is not looked at again for two days.
--
-- ⚠ SAME ANSWER, SAME SIGNATURE, SAME RULES as 20260929024333: the period is
-- the plan's, or free's with no plan, never under `p_floor_days`; bodies count
-- as well as messages; mail of a workspace id with no tenant row expires on
-- free's period.
--
-- ⚠ WHY A STALE HORIZON IS SAFE. A workspace not looked at has `oldest_at` at
-- or after its cutoff, and holds no mail before `oldest_at`, so it holds none
-- past its period. The cutoff is recomputed every run from the current plan,
-- so a downgrade from Pro to Free is seen on the next run. A workspace whose
-- mail was only partly expired (the per-run batch cap, an error, a killed pod)
-- keeps its old horizon and is looked at again next hour.
--
-- ⚠ THE FIRST RUN READS EVERYTHING ONCE, the old way, to give every workspace
-- id that holds mail a horizon. Workspaces with no mail get theirs on the same
-- run, from the probes. In production that is a few rows (no customers yet).
CREATE OR REPLACE FUNCTION "core"."retention_due"(p_floor_days integer)
RETURNS TABLE (tenant_id uuid, retention_days integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
-- The output columns are named like the tables' columns; a name in a query
-- means the column.
#variable_conflict use_column
BEGIN
  -- One run at a time; the horizons are written by whichever holds the lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('core.retention_due', 0));

  IF NOT EXISTS (SELECT 1 FROM core.retention_horizons) THEN
    INSERT INTO core.retention_horizons (tenant_id, oldest_at)
    SELECT o.tenant_id, least(min(o.created_at), now() - interval '1 hour')
      FROM (
        SELECT m.tenant_id, min(m.created_at) AS created_at
          FROM core.messages m GROUP BY m.tenant_id
        UNION ALL
        SELECT b.tenant_id, min(b.created_at)
          FROM core.message_bodies b GROUP BY b.tenant_id
      ) o
     GROUP BY o.tenant_id;
  END IF;

  RETURN QUERY
  WITH candidate AS MATERIALIZED (
    SELECT c.tenant_id, c.is_tenant, x.days,
           now() - make_interval(days => x.days) AS cutoff
      FROM (
        SELECT t.id AS tenant_id, true AS is_tenant FROM core.tenants t
        UNION ALL
        SELECT h.tenant_id, false FROM core.retention_horizons h
         WHERE NOT EXISTS (SELECT 1 FROM core.tenants t WHERE t.id = h.tenant_id)
      ) c
      LEFT JOIN core.retention_horizons h ON h.tenant_id = c.tenant_id
      LEFT JOIN core.plan_assignments a ON a.tenant_id = c.tenant_id
      LEFT JOIN core.plans p ON p.id = a.plan_id
      LEFT JOIN core.plans f ON f.id = 'free'
     CROSS JOIN LATERAL (
       SELECT greatest(p_floor_days, coalesce(p.retention_days, f.retention_days, 30)) AS days
     ) x
     WHERE h.oldest_at IS NULL
        OR h.oldest_at < now() - make_interval(days => x.days)
  ), judged AS MATERIALIZED (
    SELECT c.*,
           EXISTS (SELECT 1 FROM core.messages m
                    WHERE m.tenant_id = c.tenant_id AND m.created_at < c.cutoff)
           OR EXISTS (SELECT 1 FROM core.message_bodies b
                       WHERE b.tenant_id = c.tenant_id AND b.created_at < c.cutoff) AS due
      FROM candidate c
  ), oldest AS MATERIALIZED (
    -- Nothing before the cutoff, so the oldest is at or after it: the probes
    -- only reach the partitions from the cutoff on.
    SELECT j.tenant_id, j.is_tenant,
           least((SELECT min(m.created_at) FROM core.messages m
                   WHERE m.tenant_id = j.tenant_id AND m.created_at >= j.cutoff),
                 (SELECT min(b.created_at) FROM core.message_bodies b
                   WHERE b.tenant_id = j.tenant_id AND b.created_at >= j.cutoff)) AS oldest
      FROM judged j
     WHERE NOT j.due
  ), kept AS (
    INSERT INTO core.retention_horizons AS r (tenant_id, oldest_at)
    SELECT o.tenant_id, least(coalesce(o.oldest, 'infinity'), now() - interval '1 hour')
      FROM oldest o
     WHERE o.is_tenant OR o.oldest IS NOT NULL
     ORDER BY o.tenant_id
    ON CONFLICT ON CONSTRAINT retention_horizons_pkey DO UPDATE SET oldest_at = excluded.oldest_at
  ), dropped AS (
    -- A workspace id with no tenant row and no mail left: nothing to find.
    DELETE FROM core.retention_horizons r
     USING oldest o
     WHERE r.tenant_id = o.tenant_id AND NOT o.is_tenant AND o.oldest IS NULL
  )
  SELECT j.tenant_id, j.days FROM judged j WHERE j.due;
END
$$;
--> statement-breakpoint

-- ⚠ A DELETED TENANT ROW LEAVES ITS ID HERE, AS "LOOK NOW". Mail has no
-- foreign key to `core.tenants`, so a workspace removed by hand keeps its mail,
-- and after its row is gone `retention_due` finds it only through this table. A
-- workspace that never got a horizon (deleted before its first hourly run)
-- would otherwise never be found. `-infinity` makes it a candidate on the next
-- run: its mail is expired on free's period, and once none is left the row
-- goes. A statement trigger, so a bulk delete is one insert.
CREATE FUNCTION "core"."retention_horizons_keep_deleted"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  INSERT INTO core.retention_horizons (tenant_id, oldest_at)
  SELECT o.id, '-infinity'::timestamptz FROM old_tenants o
  ON CONFLICT ON CONSTRAINT retention_horizons_pkey
  DO UPDATE SET oldest_at = '-infinity'::timestamptz;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."retention_horizons_keep_deleted"() FROM PUBLIC, i10_api;
--> statement-breakpoint
-- CREATE TRIGGER takes a brief SHARE ROW EXCLUSIVE lock on `core.tenants`,
-- under the lock timeout above.
CREATE TRIGGER "retention_horizons_keep_deleted"
  AFTER DELETE ON "core"."tenants"
  REFERENCING OLD TABLE AS old_tenants
  FOR EACH STATEMENT EXECUTE FUNCTION "core"."retention_horizons_keep_deleted"();
