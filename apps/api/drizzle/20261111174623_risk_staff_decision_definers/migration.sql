-- Decision memory (docs/decisions/risk.md, "Decision memory"): staff
-- decisions and the concerns they covered, the evidence keys that tell one
-- concern from another, and cleared contributions kept with the snapshots.
--
-- ⚠ THE DECISIONS TABLE IS DENY-ALL, SO THESE ARE ITS ONLY DOORS, like the
-- snapshots'. Nothing deletes a decision; a revocation is recorded on it.
--
-- ⚠ DIGESTS, NEVER IDS. The keys that name another workspace or person are
-- `risk_digest` of its id: stable, so a cleared concern is recognised, and
-- opaque, because contributions are stored where the workspace can read them.
-- risk/rules.ts `digest` is the same function for the farm peers.

CREATE FUNCTION "core"."risk_digest"(p_id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = core, pg_temp
AS $$
  SELECT left(encode(sha256(convert_to(p_id, 'UTF8')), 'hex'), 16)
$$;
--> statement-breakpoint

-- Snapshots keep the cleared contributions beside the shadow ones, and the
-- save returns the new row's id (null when declined) so a decision can link
-- the facts it was made on.
DROP FUNCTION "core"."risk_fact_snapshot_save"(uuid, timestamptz, integer, text, integer, "core"."risk_band", jsonb, jsonb, jsonb, boolean);
--> statement-breakpoint
CREATE FUNCTION "core"."risk_fact_snapshot_save"(
  p_tenant uuid,
  p_at timestamptz,
  p_ruleset integer,
  p_trigger text,
  p_score integer,
  p_band "core"."risk_band",
  p_contributions jsonb,
  p_shadow jsonb,
  p_cleared jsonb,
  p_facts jsonb,
  p_force boolean
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_day timestamptz := date_trunc('day', p_at, 'UTC');
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('risk_fact_snapshot:' || p_tenant::text, 0));
  IF NOT p_force AND EXISTS (
    SELECT 1 FROM core.risk_fact_snapshots s
     WHERE s.tenant_id = p_tenant
       AND s.taken_at >= v_day AND s.taken_at < v_day + interval '1 day'
  ) THEN
    RETURN NULL;
  END IF;
  INSERT INTO core.risk_fact_snapshots
    (tenant_id, taken_at, ruleset_version, trigger, score, band, contributions, shadow, cleared, facts)
  VALUES
    (p_tenant, p_at, p_ruleset, p_trigger, p_score, p_band, p_contributions, p_shadow, p_cleared, p_facts)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
--> statement-breakpoint

DROP FUNCTION "core"."risk_fact_snapshots_list"(timestamptz, timestamptz, uuid, timestamptz, uuid, integer);
--> statement-breakpoint
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
  cleared jsonb,
  facts jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT s.id, s.tenant_id, s.taken_at, s.ruleset_version, s.trigger, s.score,
         s.band, s.contributions, s.shadow, s.cleared, s.facts
    FROM core.risk_fact_snapshots s
   WHERE s.taken_at >= p_since AND s.taken_at < p_until
     AND (p_tenant IS NULL OR s.tenant_id = p_tenant)
     AND (p_after_at IS NULL OR (s.taken_at, s.id) > (p_after_at, p_after_id))
   ORDER BY s.taken_at, s.id
   LIMIT p_limit
$$;
--> statement-breakpoint

-- identity_profile (0072), plus the digests of the people it counts, so the
-- identity rules can tell a peer already cleared from a new one.
DROP FUNCTION "core"."identity_profile"(text, timestamptz);
--> statement-breakpoint
CREATE FUNCTION "core"."identity_profile"(p_user text, p_since timestamptz)
RETURNS TABLE (
  first_seen timestamptz,
  first_country text,
  latest_country text,
  latest_timezone text,
  countries integer,
  tor_seen boolean,
  hosting_seen boolean,
  anomalies integer,
  device_peers integer,
  held_device_peers integer,
  subnet_signup_peers integer,
  held_subnet_peers integer,
  device_peer_keys text[],
  subnet_peer_keys text[],
  held_peer_keys text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH mine AS (
    SELECT * FROM core.identity_events e
     WHERE e.clerk_user_id = p_user AND e.occurred_at >= p_since
  ),
  first AS (
    SELECT e.occurred_at, e.country, e.subnet
      FROM core.identity_events e
     WHERE e.clerk_user_id = p_user AND e.kind IN ('session', 'api_key')
     ORDER BY e.occurred_at ASC LIMIT 1
  ),
  latest AS (
    SELECT e.country, e.timezone FROM core.identity_events e
     WHERE e.clerk_user_id = p_user AND e.kind = 'session' AND e.country IS NOT NULL
     ORDER BY e.occurred_at DESC LIMIT 1
  ),
  devices AS (SELECT DISTINCT device_id FROM mine WHERE device_id IS NOT NULL),
  device_peers AS (
    SELECT DISTINCT o.clerk_user_id
      FROM core.identity_events o
      JOIN devices d ON d.device_id = o.device_id
     WHERE o.clerk_user_id <> p_user AND o.occurred_at >= p_since
  ),
  subnet_peers AS (
    SELECT DISTINCT o.clerk_user_id
      FROM core.identity_events o, first f
     WHERE f.subnet IS NOT NULL
       AND o.subnet = f.subnet
       AND o.clerk_user_id <> p_user
       AND o.occurred_at BETWEEN f.occurred_at - interval '24 hours'
                             AND f.occurred_at + interval '24 hours'
       AND NOT EXISTS (
         SELECT 1 FROM core.identity_events earlier
          WHERE earlier.clerk_user_id = o.clerk_user_id
            AND earlier.occurred_at < f.occurred_at - interval '24 hours'
       )
  ),
  tainted_owners AS (
    SELECT DISTINCT t.owner_clerk_user_id AS clerk_user_id
      FROM core.risk_tainted_tenants() x JOIN core.tenants t ON t.id = x.tenant_id
  )
  SELECT
    (SELECT occurred_at FROM first),
    (SELECT country FROM first),
    (SELECT country FROM latest),
    (SELECT timezone FROM latest),
    (SELECT count(DISTINCT country)::int FROM mine WHERE country IS NOT NULL),
    coalesce((SELECT bool_or(tor) FROM mine), false),
    coalesce((SELECT bool_or(hosting) FROM mine), false),
    (SELECT count(*)::int FROM mine WHERE kind = 'anomaly'),
    (SELECT count(*)::int FROM device_peers),
    (SELECT count(*)::int FROM device_peers p JOIN tainted_owners h USING (clerk_user_id)),
    (SELECT count(*)::int FROM subnet_peers),
    (SELECT count(*)::int FROM subnet_peers p JOIN tainted_owners h USING (clerk_user_id)),
    coalesce((SELECT array_agg(core.risk_digest(clerk_user_id)) FROM device_peers), '{}'),
    coalesce((SELECT array_agg(core.risk_digest(clerk_user_id)) FROM subnet_peers), '{}'),
    coalesce((
      SELECT array_agg(DISTINCT core.risk_digest(p.clerk_user_id))
        FROM (SELECT clerk_user_id FROM device_peers
              UNION SELECT clerk_user_id FROM subnet_peers) p
        JOIN tainted_owners h USING (clerk_user_id)
    ), '{}')
$$;
--> statement-breakpoint

-- content_neighbors (0074), plus the digests of the young free and the
-- tainted neighbours, for the similarity rules' keys.
DROP FUNCTION "core"."content_neighbors"(uuid, text, date, real, text);
--> statement-breakpoint
CREATE FUNCTION "core"."content_neighbors"(
  p_tenant uuid,
  p_model text,
  p_since date,
  p_min_similarity real,
  p_free_plan text
)
RETURNS TABLE (
  similar_peers integer,
  young_free_similar integer,
  tainted_similar integer,
  best_tainted_similarity real,
  neighbours integer,
  median_similarity real,
  best_similarity real,
  young_free_keys text[],
  tainted_keys text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, public, pg_temp
SET hnsw.iterative_scan = 'relaxed_order'
SET hnsw.ef_search = 64
AS $$
  WITH mine AS (
    SELECT embedding FROM core.content_vectors
     WHERE tenant_id = p_tenant AND model = p_model AND day >= p_since
       AND trusted_by IS NULL
     ORDER BY created_at DESC LIMIT 50
  ),
  hits AS (
    SELECT n.tenant_id, n.similarity
      FROM mine m
      CROSS JOIN LATERAL (
        SELECT o.tenant_id, (1 - (o.embedding <=> m.embedding))::real AS similarity
          FROM core.content_vectors o
         WHERE o.model = p_model AND o.day >= p_since AND o.tenant_id <> p_tenant
           AND o.trusted_by IS NULL
         ORDER BY o.embedding <=> m.embedding
         LIMIT 20
      ) n
     WHERE n.similarity >= p_min_similarity
  ),
  peers AS (
    SELECT h.tenant_id, max(h.similarity) AS similarity FROM hits h GROUP BY h.tenant_id
  ),
  young_free AS (
    SELECT p.tenant_id FROM peers p
      JOIN core.tenants t ON t.id = p.tenant_id
      LEFT JOIN core.plan_assignments a ON a.tenant_id = p.tenant_id
     WHERE t.created_at > now() - interval '30 days'
       AND coalesce(a.plan_id = p_free_plan, true)
  ),
  tainted AS (SELECT tenant_id FROM core.risk_tainted_tenants())
  SELECT
    (SELECT count(*)::int FROM peers),
    (SELECT count(*)::int FROM young_free),
    (SELECT count(*)::int FROM peers p WHERE p.tenant_id IN (SELECT tenant_id FROM tainted)),
    (SELECT max(p.similarity) FROM peers p WHERE p.tenant_id IN (SELECT tenant_id FROM tainted)),
    (SELECT count(*)::int FROM hits),
    (SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY h.similarity))::real FROM hits h),
    (SELECT max(h.similarity) FROM hits h),
    coalesce((SELECT array_agg(core.risk_digest(tenant_id::text)) FROM young_free), '{}'),
    coalesce((
      SELECT array_agg(core.risk_digest(p.tenant_id::text)) FROM peers p
       WHERE p.tenant_id IN (SELECT tenant_id FROM tainted)
    ), '{}')
$$;
--> statement-breakpoint

-- Records a staff decision.
--
-- ⚠ ONLY A RELEASE OR A PIN CLEARS ANYTHING. An uphold or a staff hold that
-- claims to cover a concern is refused here.
CREATE FUNCTION "core"."risk_decision_save"(
  p_tenant uuid,
  p_kind "core"."risk_decision_kind",
  p_by text,
  p_note text,
  p_at timestamptz,
  p_score integer,
  p_band "core"."risk_band",
  p_ruleset integer,
  p_held boolean,
  p_in_view jsonb,
  p_covers jsonb,
  p_expires_at timestamptz,
  p_snapshot uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF coalesce(btrim(p_note), '') = '' OR coalesce(btrim(p_by), '') = '' THEN
    RAISE EXCEPTION 'a staff decision needs who made it and a note';
  END IF;
  IF p_kind NOT IN ('release', 'pin') AND jsonb_array_length(p_covers) > 0 THEN
    RAISE EXCEPTION 'only a release or a pin clears a concern';
  END IF;
  INSERT INTO core.risk_staff_decisions
    (tenant_id, kind, decided_by, note, decided_at, score, band, ruleset_version,
     held, in_view, covers, expires_at, snapshot_id)
  VALUES
    (p_tenant, p_kind, p_by, p_note, p_at, p_score, p_band, p_ruleset,
     p_held, p_in_view, p_covers, p_expires_at, p_snapshot)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
--> statement-breakpoint

-- The decisions that may clear a concern at p_at, for the facts: releases and
-- pins made by then and not yet expired. Revoked ones come with their
-- revocation; evaluation skips them, so a replay of older facts still sees
-- what was in effect when they were taken.
CREATE FUNCTION "core"."risk_decisions_in_effect"(p_tenant uuid, p_at timestamptz)
RETURNS TABLE (
  id uuid,
  kind "core"."risk_decision_kind",
  decided_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  covers jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.id, d.kind, d.decided_at, d.expires_at, d.revoked_at, d.covers
    FROM core.risk_staff_decisions d
   WHERE d.tenant_id = p_tenant
     AND d.kind IN ('release', 'pin')
     AND d.decided_at <= p_at AND d.expires_at > p_at
   ORDER BY d.decided_at, d.id
$$;
--> statement-breakpoint

-- Every decision, for `risk-admin decisions` (p_tenant) and the case export
-- (p_tenant null), newest first.
CREATE FUNCTION "core"."risk_decisions_list"(p_tenant uuid)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  kind "core"."risk_decision_kind",
  decided_by text,
  note text,
  decided_at timestamptz,
  score integer,
  band "core"."risk_band",
  ruleset_version integer,
  held boolean,
  in_view jsonb,
  covers jsonb,
  expires_at timestamptz,
  snapshot_id uuid,
  revoked_at timestamptz,
  revoked_by text,
  revoke_note text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.id, d.tenant_id, d.kind, d.decided_by, d.note, d.decided_at, d.score,
         d.band, d.ruleset_version, d.held, d.in_view, d.covers, d.expires_at,
         d.snapshot_id, d.revoked_at, d.revoked_by, d.revoke_note
    FROM core.risk_staff_decisions d
   WHERE p_tenant IS NULL OR d.tenant_id = p_tenant
   ORDER BY d.decided_at DESC, d.id DESC
$$;
--> statement-breakpoint

-- Revokes a decision's clearing. ⚠ RECORDED ON THE ROW, NEVER A DELETE, and
-- only once. Returns the workspace, or null when there was nothing to revoke.
CREATE FUNCTION "core"."risk_decision_revoke"(
  p_id uuid,
  p_by text,
  p_note text,
  p_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  IF coalesce(btrim(p_note), '') = '' OR coalesce(btrim(p_by), '') = '' THEN
    RAISE EXCEPTION 'a revocation needs who made it and a note';
  END IF;
  UPDATE core.risk_staff_decisions
     SET revoked_at = p_at, revoked_by = p_by, revoke_note = p_note
   WHERE id = p_id AND revoked_at IS NULL
  RETURNING tenant_id INTO v_tenant;
  RETURN v_tenant;
END
$$;
--> statement-breakpoint

-- ⚠ FUNCTIONS ARE EXECUTABLE BY PUBLIC UNTIL REVOKED (see 0074). The API, the
-- hourly job and risk-admin all connect as i10_api.
REVOKE EXECUTE ON FUNCTION
  "core"."risk_digest"(text),
  "core"."risk_fact_snapshot_save"(uuid, timestamptz, integer, text, integer, "core"."risk_band", jsonb, jsonb, jsonb, jsonb, boolean),
  "core"."risk_fact_snapshots_list"(timestamptz, timestamptz, uuid, timestamptz, uuid, integer),
  "core"."identity_profile"(text, timestamptz),
  "core"."content_neighbors"(uuid, text, date, real, text),
  "core"."risk_decision_save"(uuid, "core"."risk_decision_kind", text, text, timestamptz, integer, "core"."risk_band", integer, boolean, jsonb, jsonb, timestamptz, uuid),
  "core"."risk_decisions_in_effect"(uuid, timestamptz),
  "core"."risk_decisions_list"(uuid),
  "core"."risk_decision_revoke"(uuid, text, text, timestamptz)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  "core"."risk_digest"(text),
  "core"."risk_fact_snapshot_save"(uuid, timestamptz, integer, text, integer, "core"."risk_band", jsonb, jsonb, jsonb, jsonb, boolean),
  "core"."risk_fact_snapshots_list"(timestamptz, timestamptz, uuid, timestamptz, uuid, integer),
  "core"."identity_profile"(text, timestamptz),
  "core"."content_neighbors"(uuid, text, date, real, text),
  "core"."risk_decision_save"(uuid, "core"."risk_decision_kind", text, text, timestamptz, integer, "core"."risk_band", integer, boolean, jsonb, jsonb, timestamptz, uuid),
  "core"."risk_decisions_in_effect"(uuid, timestamptz),
  "core"."risk_decisions_list"(uuid),
  "core"."risk_decision_revoke"(uuid, text, text, timestamptz)
TO i10_api;
