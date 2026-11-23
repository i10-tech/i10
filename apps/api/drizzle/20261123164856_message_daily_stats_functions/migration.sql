SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- The console overview's chart from a daily rollup (#507).
--
-- Before this, `core.message_stats` counted the workspace's events for every
-- day of the window on every load of the console home. For the largest
-- workspace on the scale seed that read about a million event rows (366 ms p50,
-- 806 ms p95, 231 MB). Now every day before the last refresh comes from
-- `core.message_daily_stats`, one row per day, and only the days since then
-- (normally today) are counted from the events, through
-- `message_events_tenant_idx`.
--
-- ⚠ UTC DAYS, PINNED WITH `SET TimeZone`. The old body bucketed by the
-- session's time zone, which is UTC in production; the rollup is stored by UTC
-- day, so both halves of the new body must agree on what a day is.

-- Recomputes the cells that changed since the last run. Called by the
-- `i10-message-stats` CronJob as `i10_api`.
--
-- ⚠ WHICH CELLS CHANGED IS READ FROM THE EVENT IDS, NOT FROM `occurred_at`.
-- `id` defaults to `uuidv7()`, minted by this server when the row is inserted,
-- so it orders events by when they arrived. A bounce or complaint can arrive
-- days after the day it belongs to; scanning by arrival finds it, and its own
-- day is recomputed. Each partition's primary key leads with `id`, so the scan
-- is one short index range per partition and needs no new index on the event
-- table.
--
-- ⚠ THE SCAN STARTS AN HOUR BEFORE THE PREVIOUS RUN BEGAN. An event's id is
-- minted when its INSERT runs, but the row becomes visible at COMMIT. An event
-- whose transaction committed after the previous run read the table has an id
-- newer than that run's start minus the transaction's length. The only writer
-- (`webhooks/db.ts` `record`) commits in milliseconds, and
-- `idle_in_transaction_session_timeout` is 5 minutes (cluster.yaml), so an hour
-- is a wide margin. Rescanning the overlap is harmless: a cell is recomputed
-- from scratch, never incremented.
--
-- ⚠ A CELL IS RECOUNTED, NOT ADDED TO, so a rerun, an overlap or a crashed run
-- leaves the table correct. Unchanged cells are not rewritten.
--
-- ⚠ AND A RECOUNT NEVER LOWERS A COUNT (`greatest`, per column). Events are
-- only ever removed by retention (with their message), a workspace's deletion
-- or a flush by hand, and the chart keeps a day's counts past all three. So a
-- day whose older events retention has deleted keeps its counts when a late
-- event for it arrives; the one thing lost is that late event itself if its
-- column already held more than the recount (an undercount of late events,
-- never a drop).
--
-- ⚠ ONLY WORKSPACES THAT STILL HAVE A TENANT ROW. Events carry no foreign key,
-- so a flushed workspace's events can outlive it; their cells would break this
-- table's key to `core.tenants` and fail the whole run.
--
-- ⚠ THE FIRST RUN COUNTS EVERYTHING the overview can show (100 days), in one
-- aggregate. Until it has committed there is no state row, and
-- `core.message_stats` counts every day from the events as before.
CREATE FUNCTION "core"."refresh_message_daily_stats"()
RETURNS TABLE (cells integer, pruned integer, complete_before date)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
SET "TimeZone" = 'UTC'
AS $$
DECLARE
  -- Taken before anything is read, so every later snapshot is at least this new.
  v_started timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  -- The overview shows at most 90 days (routes/console/sending.ts).
  v_keep_from date := (clock_timestamp() AT TIME ZONE 'UTC')::date - 100;
  v_prev timestamptz;
  v_floor uuid;
  v_cells integer := 0;
  v_pruned integer := 0;
BEGIN
  -- One run at a time; a second waits, then rescans what the first wrote.
  PERFORM pg_advisory_xact_lock(hashtextextended('core.refresh_message_daily_stats', 0));

  SELECT s.started_at INTO v_prev FROM core.message_daily_stats_state s;

  IF v_prev IS NULL THEN
    INSERT INTO core.message_daily_stats AS d
      (tenant_id, day, sent, delivered, bounced, complained, delayed, failed)
    SELECT e.tenant_id,
           (e.occurred_at AT TIME ZONE 'UTC')::date,
           count(*) FILTER (WHERE e.type = 'sent'),
           count(*) FILTER (WHERE e.type = 'delivered'),
           count(*) FILTER (WHERE e.type = 'bounced'),
           count(*) FILTER (WHERE e.type = 'complained'),
           count(*) FILTER (WHERE e.type = 'delivery_delayed'),
           count(*) FILTER (WHERE e.type IN ('failed', 'rejected'))
      FROM core.message_events e
     WHERE e.occurred_at >= v_keep_from::timestamp AT TIME ZONE 'UTC'
       AND EXISTS (SELECT 1 FROM core.tenants t WHERE t.id = e.tenant_id)
       AND e.type IN ('sent', 'delivered', 'bounced', 'complained',
                      'delivery_delayed', 'failed', 'rejected')
     GROUP BY 1, 2
    ON CONFLICT (tenant_id, day) DO UPDATE
       SET sent = greatest(d.sent, excluded.sent),
           delivered = greatest(d.delivered, excluded.delivered),
           bounced = greatest(d.bounced, excluded.bounced),
           complained = greatest(d.complained, excluded.complained),
           delayed = greatest(d.delayed, excluded.delayed),
           failed = greatest(d.failed, excluded.failed)
     WHERE excluded.sent > d.sent OR excluded.delivered > d.delivered
        OR excluded.bounced > d.bounced OR excluded.complained > d.complained
        OR excluded.delayed > d.delayed OR excluded.failed > d.failed;
  ELSE
    -- The smallest uuidv7 of the millisecond an hour before the last run: 48
    -- bits of Unix milliseconds, then zeros. uuids compare byte by byte.
    v_floor := (lpad(to_hex(floor(extract(epoch FROM v_prev - interval '1 hour') * 1000)::bigint), 12, '0')
                || '00000000000000000000')::uuid;

    WITH touched AS (
      SELECT DISTINCT e.tenant_id, (e.occurred_at AT TIME ZONE 'UTC')::date AS day
        FROM core.message_events e
       WHERE e.id >= v_floor
         AND e.type IN ('sent', 'delivered', 'bounced', 'complained',
                        'delivery_delayed', 'failed', 'rejected')
    )
    INSERT INTO core.message_daily_stats AS d
      (tenant_id, day, sent, delivered, bounced, complained, delayed, failed)
    SELECT t.tenant_id, t.day, c.sent, c.delivered, c.bounced, c.complained,
           c.delayed, c.failed
      FROM touched t
     CROSS JOIN LATERAL (
       SELECT count(*) FILTER (WHERE e.type = 'sent') AS sent,
              count(*) FILTER (WHERE e.type = 'delivered') AS delivered,
              count(*) FILTER (WHERE e.type = 'bounced') AS bounced,
              count(*) FILTER (WHERE e.type = 'complained') AS complained,
              count(*) FILTER (WHERE e.type = 'delivery_delayed') AS delayed,
              count(*) FILTER (WHERE e.type IN ('failed', 'rejected')) AS failed
         FROM core.message_events e
        WHERE e.tenant_id = t.tenant_id
          AND e.occurred_at >= t.day::timestamp AT TIME ZONE 'UTC'
          AND e.occurred_at < (t.day + 1)::timestamp AT TIME ZONE 'UTC'
     ) c
     WHERE t.day >= v_keep_from
       AND EXISTS (SELECT 1 FROM core.tenants w WHERE w.id = t.tenant_id)
    ON CONFLICT (tenant_id, day) DO UPDATE
       SET sent = greatest(d.sent, excluded.sent),
           delivered = greatest(d.delivered, excluded.delivered),
           bounced = greatest(d.bounced, excluded.bounced),
           complained = greatest(d.complained, excluded.complained),
           delayed = greatest(d.delayed, excluded.delayed),
           failed = greatest(d.failed, excluded.failed)
     WHERE excluded.sent > d.sent OR excluded.delivered > d.delivered
        OR excluded.bounced > d.bounced OR excluded.complained > d.complained
        OR excluded.delayed > d.delayed OR excluded.failed > d.failed;
  END IF;
  GET DIAGNOSTICS v_cells = ROW_COUNT;

  -- Once a day, on the first run after midnight UTC.
  IF v_prev IS NULL OR (v_prev AT TIME ZONE 'UTC')::date < v_today THEN
    DELETE FROM core.message_daily_stats WHERE day < v_keep_from;
    GET DIAGNOSTICS v_pruned = ROW_COUNT;
  END IF;

  INSERT INTO core.message_daily_stats_state (id, started_at, complete_before)
  VALUES (true, v_started, v_today)
  ON CONFLICT (id) DO UPDATE
     SET started_at = excluded.started_at, complete_before = excluded.complete_before;

  RETURN QUERY SELECT v_cells, v_pruned, v_today;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."refresh_message_daily_stats"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."refresh_message_daily_stats"() TO i10_api;
--> statement-breakpoint

-- The same signature, result and SECURITY INVOKER as 20260917035548, so RLS
-- still decides what a caller sees. Days before `complete_before` come from the
-- rollup, the rest from the events; with no state row (before the first
-- refresh) every day comes from the events, as before.
--
-- ⚠ THE ROLLUP KEEPS 100 DAYS. The overview asks for at most 90; a window that
-- starts earlier reads zeros for the days before the rollup's horizon.
--
-- ⚠ ITS COUNTS OUTLIVE RETENTION. Retention deletes a workspace's old events
-- with its messages; the rollup keeps that day's counts, so the chart no longer
-- drops to zero on days whose mail has expired. They are counts per day, no
-- message, address or content.
CREATE OR REPLACE FUNCTION "core"."message_stats"(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  bucket timestamptz,
  sent bigint,
  delivered bigint,
  bounced bigint,
  complained bigint,
  delayed bigint,
  failed bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = core, pg_temp
SET "TimeZone" = 'UTC'
AS $$
-- ⚠ PLPGSQL SO THE BOUNDS ARE PARAMETERS. Read from the state table inside the
-- query, the lower bound of the events half was a join: as `i10_api`, RLS kept
-- it from reaching the index, and every partition was scanned (3.7 s on the
-- scale seed). As a variable it is an index condition, and run-time pruning
-- leaves one partition.
DECLARE
  v_first date := date_trunc('day', p_from)::date;
  v_last date := date_trunc('day', p_to)::date;
  v_complete date;
BEGIN
  SELECT s.complete_before INTO v_complete FROM core.message_daily_stats_state s;
  v_complete := coalesce(v_complete, '-infinity'::date);

  RETURN QUERY
  WITH counted AS (
    SELECT r.day, r.sent::bigint AS sent, r.delivered::bigint AS delivered,
           r.bounced::bigint AS bounced, r.complained::bigint AS complained,
           r.delayed::bigint AS delayed, r.failed::bigint AS failed
      FROM core.message_daily_stats r
     WHERE r.tenant_id = p_tenant_id
       AND r.day >= v_first
       AND r.day <= v_last
       AND r.day < v_complete
    UNION ALL
    -- ⚠ BOUNDED BELOW BY THE LAST REFRESH, so this reads today's events (two
    -- days just after midnight), not the window's.
    SELECT (me.occurred_at AT TIME ZONE 'UTC')::date,
           count(*) FILTER (WHERE me.type = 'sent'),
           count(*) FILTER (WHERE me.type = 'delivered'),
           count(*) FILTER (WHERE me.type = 'bounced'),
           count(*) FILTER (WHERE me.type = 'complained'),
           count(*) FILTER (WHERE me.type = 'delivery_delayed'),
           count(*) FILTER (WHERE me.type IN ('failed', 'rejected'))
      FROM core.message_events me
     WHERE me.tenant_id = p_tenant_id
       AND me.occurred_at >= greatest(v_first, v_complete)::timestamp AT TIME ZONE 'UTC'
       AND me.occurred_at < (v_last + 1)::timestamp AT TIME ZONE 'UTC'
     GROUP BY 1
  )
  -- ⚠ `generate_series` ON THE LEFT, SO EMPTY DAYS ARE ROWS RATHER THAN GAPS
  -- (see 20260917035548).
  SELECT d.bucket,
         coalesce(c.sent, 0), coalesce(c.delivered, 0), coalesce(c.bounced, 0),
         coalesce(c.complained, 0), coalesce(c.delayed, 0), coalesce(c.failed, 0)
    FROM generate_series(v_first::timestamp AT TIME ZONE 'UTC',
                         v_last::timestamp AT TIME ZONE 'UTC',
                         interval '1 day') AS d(bucket)
    LEFT JOIN counted c ON c.day = d.bucket::date
   ORDER BY d.bucket;
END
$$;
