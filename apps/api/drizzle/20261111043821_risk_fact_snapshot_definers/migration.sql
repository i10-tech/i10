-- Fact snapshots for replay (docs/decisions/risk.md, "Snapshots, replay and
-- shadow rules").
--
-- ⚠ THE TABLE IS DENY-ALL, SO THESE ARE ITS ONLY DOORS, like the boilerplate
-- list's. The facts carry other workspaces' ids and the owner's identity
-- signals; no tenant-scoped query may ever see a row.

-- Writes a snapshot, or declines to.
--
-- ⚠ ONE PER WORKSPACE PER UTC DAY UNLESS FORCED. The runner forces it when the
-- event log writes an event (a first assessment, a band change, a swing of
-- EVENT_SWING points, an action); otherwise the first score of a UTC day is
-- kept and the rest of that day's hourly runs are not. The advisory lock keeps
-- that true when two scores of one workspace race without the Redis lease.
CREATE FUNCTION "core"."risk_fact_snapshot_save"(
  p_tenant uuid,
  p_at timestamptz,
  p_ruleset integer,
  p_trigger text,
  p_score integer,
  p_band "core"."risk_band",
  p_contributions jsonb,
  p_shadow jsonb,
  p_facts jsonb,
  p_force boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_day timestamptz := date_trunc('day', p_at, 'UTC');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('risk_fact_snapshot:' || p_tenant::text, 0));
  IF NOT p_force AND EXISTS (
    SELECT 1 FROM core.risk_fact_snapshots s
     WHERE s.tenant_id = p_tenant
       AND s.taken_at >= v_day AND s.taken_at < v_day + interval '1 day'
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO core.risk_fact_snapshots
    (tenant_id, taken_at, ruleset_version, trigger, score, band, contributions, shadow, facts)
  VALUES
    (p_tenant, p_at, p_ruleset, p_trigger, p_score, p_band, p_contributions, p_shadow, p_facts);
  RETURN true;
END
$$;
--> statement-breakpoint

-- One page of snapshots in [p_since, p_until), oldest first, optionally for
-- one workspace. Keyset paging on (taken_at, id): pass the last row's pair.
CREATE FUNCTION "core"."risk_fact_snapshots_list"(
  p_since timestamptz,
  p_until timestamptz,
  p_tenant uuid,
  p_after_at timestamptz,
  p_after_id uuid,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  taken_at timestamptz,
  ruleset_version integer,
  trigger text,
  score integer,
  band "core"."risk_band",
  contributions jsonb,
  shadow jsonb,
  facts jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT s.id, s.tenant_id, s.taken_at, s.ruleset_version, s.trigger, s.score,
         s.band, s.contributions, s.shadow, s.facts
    FROM core.risk_fact_snapshots s
   WHERE s.taken_at >= p_since AND s.taken_at < p_until
     AND (p_tenant IS NULL OR s.tenant_id = p_tenant)
     AND (p_after_at IS NULL OR (s.taken_at, s.id) > (p_after_at, p_after_id))
   ORDER BY s.taken_at, s.id
   LIMIT p_limit
$$;
--> statement-breakpoint

-- Deletes every snapshot taken before p_before, for the hourly run.
CREATE FUNCTION "core"."risk_fact_snapshots_purge"(p_before timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM core.risk_fact_snapshots WHERE taken_at < p_before;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
--> statement-breakpoint

-- ⚠ FUNCTIONS ARE EXECUTABLE BY PUBLIC UNTIL REVOKED (see 0074). The API, the
-- hourly job and risk-admin all connect as i10_api.
REVOKE EXECUTE ON FUNCTION
  "core"."risk_fact_snapshot_save"(uuid, timestamptz, integer, text, integer, "core"."risk_band", jsonb, jsonb, jsonb, boolean),
  "core"."risk_fact_snapshots_list"(timestamptz, timestamptz, uuid, timestamptz, uuid, integer),
  "core"."risk_fact_snapshots_purge"(timestamptz)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  "core"."risk_fact_snapshot_save"(uuid, timestamptz, integer, text, integer, "core"."risk_band", jsonb, jsonb, jsonb, boolean),
  "core"."risk_fact_snapshots_list"(timestamptz, timestamptz, uuid, timestamptz, uuid, integer),
  "core"."risk_fact_snapshots_purge"(timestamptz)
TO i10_api;
