-- ⚠ A LOCK TIMEOUT FIRST. CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on
-- `core.meter_events`, which waits behind any open writer and blocks the send
-- path's usage records while it waits. Five seconds and it fails (the Job
-- retries) instead of queueing every later write.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- Keeps `core.meter_usage_hourly` equal to `core.meter_events` summed per
-- tenant, feature, shard and hour (#507). Before this, every accepted send
-- summed the tenant's whole window from the events: 22.9 ms and 99 MB for the
-- largest workspace's month on the scale seed, linear in its volume.
--
-- ⚠ STATEMENT TRIGGERS WITH TRANSITION TABLES, so a batch of a hundred usage
-- events is one upsert per hour it touches, not a hundred. `NEW TABLE` of an
-- `INSERT ... ON CONFLICT DO NOTHING` holds only the rows actually inserted, so
-- a replayed message id adds nothing, exactly as it adds no event.
--
-- ⚠ DEFINER FUNCTIONS, because the API may read the rollup but not write it
-- (its policy is SELECT only). They run inside the writer's transaction, so the
-- count and the event commit or roll back together.
--
-- ⚠ ROWS IN A FIXED ORDER. Two transactions upserting the same rows in
-- different orders deadlock; sorted, the second waits for the first.

CREATE FUNCTION "core"."meter_usage_hourly_add"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  INSERT INTO core.meter_usage_hourly AS u (tenant_id, feature_id, shard, hour, slot, used)
  SELECT n.tenant_id, n.feature_id, n.shard,
         date_bin('1 hour', n.occurred_at, timestamptz '2000-01-01 00:00:00+00'),
         (pg_backend_pid() % 4)::smallint,
         sum(n.value)
    FROM new_events n
   GROUP BY 1, 2, 3, 4
   ORDER BY 1, 2, 3, 4
  ON CONFLICT (tenant_id, feature_id, shard, hour, slot)
  DO UPDATE SET used = u.used + excluded.used;
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- ⚠ A DELETE TAKES ITS COUNT OFF ONE EXISTING SLOT, AND NEVER INSERTS. Which
-- slot an event was added to is not recorded, and readers only use the sum. Not
-- inserting matters when a workspace is deleted: its rollup rows may already be
-- gone by the same cascade, and a new row would point at a missing tenant.
CREATE FUNCTION "core"."meter_usage_hourly_remove"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  UPDATE core.meter_usage_hourly u
     SET used = u.used - o.used
    FROM (SELECT d.tenant_id, d.feature_id, d.shard,
                 date_bin('1 hour', d.occurred_at, timestamptz '2000-01-01 00:00:00+00') AS hour,
                 sum(d.value) AS used
            FROM old_events d
           GROUP BY 1, 2, 3, 4) o
   WHERE u.tenant_id = o.tenant_id AND u.feature_id = o.feature_id
     AND u.shard = o.shard AND u.hour = o.hour
     AND u.slot = (SELECT min(x.slot) FROM core.meter_usage_hourly x
                    WHERE x.tenant_id = o.tenant_id AND x.feature_id = o.feature_id
                      AND x.shard = o.shard AND x.hour = o.hour);
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- ⚠ THE LEDGER IS APPEND-ONLY, AND NOW THAT IS ENFORCED. Changing an event's
-- tenant, feature, shard, value or time would move usage between windows
-- without the rollup knowing. Nothing does it: the only update is the Polar
-- flush setting `ingested_at` (metering/ingest.ts), which this trigger does not
-- watch.
CREATE FUNCTION "core"."meter_events_append_only"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = core, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'core.meter_events is append-only: % cannot change', TG_ARGV[0]
    USING ERRCODE = 'object_not_in_prerequisite_state';
END
$$;
--> statement-breakpoint
CREATE FUNCTION "core"."meter_usage_hourly_truncate"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  DELETE FROM core.meter_usage_hourly;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."meter_usage_hourly_add"() FROM PUBLIC, i10_api;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."meter_usage_hourly_remove"() FROM PUBLIC, i10_api;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."meter_usage_hourly_truncate"() FROM PUBLIC, i10_api;
--> statement-breakpoint
CREATE TRIGGER "meter_usage_hourly_add"
  AFTER INSERT ON "core"."meter_events"
  REFERENCING NEW TABLE AS new_events
  FOR EACH STATEMENT EXECUTE FUNCTION "core"."meter_usage_hourly_add"();
--> statement-breakpoint
CREATE TRIGGER "meter_usage_hourly_remove"
  AFTER DELETE ON "core"."meter_events"
  REFERENCING OLD TABLE AS old_events
  FOR EACH STATEMENT EXECUTE FUNCTION "core"."meter_usage_hourly_remove"();
--> statement-breakpoint
CREATE TRIGGER "meter_usage_hourly_truncate"
  AFTER TRUNCATE ON "core"."meter_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "core"."meter_usage_hourly_truncate"();
--> statement-breakpoint
CREATE TRIGGER "meter_events_append_only"
  BEFORE UPDATE OF tenant_id, feature_id, shard, value, occurred_at ON "core"."meter_events"
  FOR EACH ROW
  WHEN ((OLD.tenant_id, OLD.feature_id, OLD.shard, OLD.value, OLD.occurred_at)
        IS DISTINCT FROM
        (NEW.tenant_id, NEW.feature_id, NEW.shard, NEW.value, NEW.occurred_at))
  EXECUTE FUNCTION "core"."meter_events_append_only"('tenant_id, feature_id, shard, value or occurred_at');
--> statement-breakpoint

-- ⚠ THE BACKFILL, UNDER THE TRIGGERS' LOCK. CREATE TRIGGER above holds SHARE
-- ROW EXCLUSIVE on `core.meter_events` until this migration commits, so no
-- usage can be written between the snapshot this reads and the triggers taking
-- over: the rollup starts exact. Production has almost no usage yet (no
-- customers), so the scan is short; on the 2.9 million event scale seed it
-- took 8.4 s. Sorted by hour so rows are laid out in time order, as the
-- triggers will lay out the rest.
--
-- ⚠ ONLY BECAUSE THE TABLE IS NEARLY EMPTY. Applied to a database with real
-- volume, this full scan would block every usage write for its length: split it
-- out into a batched backfill job, with the gate reading the events until it
-- has finished, before applying this anywhere that has customers.
INSERT INTO "core"."meter_usage_hourly" (tenant_id, feature_id, shard, hour, slot, used)
SELECT e.tenant_id, e.feature_id, e.shard,
       date_bin('1 hour', e.occurred_at, timestamptz '2000-01-01 00:00:00+00'),
       0, sum(e.value)
  FROM "core"."meter_events" e
 GROUP BY 1, 2, 3, 4
 ORDER BY 4, 1, 2, 3;
