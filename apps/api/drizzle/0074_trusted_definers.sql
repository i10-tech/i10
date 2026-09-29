-- Trusted content and similarity evidence for the risk engine (#222).
--
-- ⚠ THE BOILERPLATE LIST IS GLOBAL, SO IT IS DENY-ALL AND LIVES BEHIND THESE
-- FUNCTIONS, like `risk_models`. Staff change it through `risk-admin`; every
-- change writes an event in the same statement.
--
-- ⚠ TRUSTED CONTENT IS EXCLUDED ON BOTH SIDES OF EVERY SIMILARITY QUESTION.
-- A workspace's boilerplate does not count against it, and does not count as
-- evidence against anybody else either: fifty workspaces sending Clerk's
-- default reset email are fifty workspaces that installed Clerk.
--
-- ⚠ STILL COUNTS AND DISTANCES ONLY. The evidence columns added below are
-- numbers about neighbours, never a neighbour's id, content or domains.

-- The list, for matching (content/trust.ts) and for staff.
CREATE FUNCTION "core"."risk_boilerplate_list"()
RETURNS TABLE (
  id uuid,
  name text,
  skeleton_hash text,
  segments jsonb,
  hole_limits jsonb,
  bands text[],
  static_bytes integer,
  holes integer,
  model text,
  reason text,
  added_by text,
  added_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT b.id, b.name, b.skeleton_hash, b.segments, b.hole_limits, b.bands,
         b.static_bytes, b.holes, b.model, b.reason, b.added_by, b.added_at
    FROM core.risk_boilerplate b
   ORDER BY b.name
$$;
--> statement-breakpoint

-- Adds an entry. ⚠ A REASON AND A NAME FOR WHO, OR NOTHING: the audit row is
-- written in the same transaction as the entry, and cannot be skipped.
CREATE FUNCTION "core"."risk_boilerplate_add"(
  p_name text,
  p_skeleton_hash text,
  p_segments jsonb,
  p_hole_limits jsonb,
  p_bands text[],
  p_static_bytes integer,
  p_holes integer,
  p_model text,
  p_embedding text,
  p_reason text,
  p_by text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF coalesce(btrim(p_reason), '') = '' OR coalesce(btrim(p_by), '') = '' THEN
    RAISE EXCEPTION 'a boilerplate change needs a reason and who made it';
  END IF;
  INSERT INTO core.risk_boilerplate
    (name, skeleton_hash, segments, hole_limits, bands, static_bytes, holes,
     model, embedding, reason, added_by)
  VALUES
    (p_name, p_skeleton_hash, p_segments, p_hole_limits, p_bands, p_static_bytes,
     p_holes, p_model, p_embedding::halfvec, p_reason, p_by)
  RETURNING id INTO v_id;
  INSERT INTO core.risk_boilerplate_events
    (boilerplate_id, name, skeleton_hash, action, set_by, reason)
  VALUES (v_id, p_name, p_skeleton_hash, 'add', p_by, p_reason);
  RETURN v_id;
END
$$;
--> statement-breakpoint

-- Removes an entry, and stops excusing the content it excused.
--
-- ⚠ THE MARKS COME OFF EVERY WORKSPACE'S FINGERPRINTS AND VECTORS, which is
-- why this is a definer: an entry removed because it was being abused must
-- not keep excusing the last thirty days of that abuse.
CREATE FUNCTION "core"."risk_boilerplate_remove"(p_id uuid, p_reason text, p_by text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_name text;
  v_hash text;
BEGIN
  IF coalesce(btrim(p_reason), '') = '' OR coalesce(btrim(p_by), '') = '' THEN
    RAISE EXCEPTION 'a boilerplate change needs a reason and who made it';
  END IF;
  DELETE FROM core.risk_boilerplate WHERE id = p_id
  RETURNING name, skeleton_hash INTO v_name, v_hash;
  IF v_name IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO core.risk_boilerplate_events
    (boilerplate_id, name, skeleton_hash, action, set_by, reason)
  VALUES (p_id, v_name, v_hash, 'remove', p_by, p_reason);
  UPDATE core.content_fingerprints SET trusted_by = NULL
   WHERE trusted_by = 'boilerplate:' || p_id::text;
  UPDATE core.content_vectors SET trusted_by = NULL
   WHERE trusted_by = 'boilerplate:' || p_id::text;
  RETURN true;
END
$$;
--> statement-breakpoint

-- The audit trail, newest first.
CREATE FUNCTION "core"."risk_boilerplate_history"(p_limit integer)
RETURNS TABLE (
  occurred_at timestamptz,
  action text,
  boilerplate_id uuid,
  name text,
  skeleton_hash text,
  set_by text,
  reason text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT e.occurred_at, e.action, e.boilerplate_id, e.name, e.skeleton_hash,
         e.set_by, e.reason
    FROM core.risk_boilerplate_events e
   ORDER BY e.occurred_at DESC
   LIMIT p_limit
$$;
--> statement-breakpoint

-- The boilerplate entry this workspace's recent, UNEXCUSED mail comes closest
-- to, by embedding. Evidence for staff only ("reads like Clerk's reset email,
-- 0.96, but did not fit it exactly - a variant worth adding?"); it excuses
-- nothing. The name of a global entry, never anything of another workspace.
CREATE FUNCTION "core"."risk_boilerplate_nearest"(p_tenant uuid, p_model text, p_since date)
RETURNS TABLE (name text, similarity real)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, public, pg_temp
AS $$
  WITH mine AS (
    SELECT v.embedding FROM core.content_vectors v
     WHERE v.tenant_id = p_tenant AND v.model = p_model AND v.day >= p_since
       AND v.trusted_by IS NULL
     ORDER BY v.created_at DESC LIMIT 50
  )
  SELECT b.name, max((1 - (b.embedding <=> m.embedding))::real)
    FROM core.risk_boilerplate b CROSS JOIN mine m
   WHERE b.model = p_model AND b.embedding IS NOT NULL
   GROUP BY b.name
   ORDER BY 2 DESC
   LIMIT 1
$$;
--> statement-breakpoint

-- Staff's review queue: which workspaces are waiting, and for what. Names and
-- counts; the content is read inside the workspace, under its own policy.
CREATE FUNCTION "core"."trusted_templates_pending"()
RETURNS TABLE (id uuid, tenant_id uuid, name text, holes integer, submitted_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT t.id, t.tenant_id, t.name, jsonb_array_length(t.holes), t.submitted_at
    FROM core.trusted_templates t
   WHERE t.status = 'pending'
   ORDER BY t.submitted_at
$$;
--> statement-breakpoint

-- Which workspace a submission belongs to, so staff can act on an id alone.
CREATE FUNCTION "core"."trusted_template_tenant"(p_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT t.tenant_id FROM core.trusted_templates t WHERE t.id = p_id
$$;
--> statement-breakpoint

-- Farm peers, now excluding trusted content on both sides and saying how
-- close the closest near-duplicate came (`best_near_bands` of 8).
DROP FUNCTION "core"."fingerprint_peers"(uuid, date);
--> statement-breakpoint
CREATE FUNCTION "core"."fingerprint_peers"(p_tenant uuid, p_since date)
RETURNS TABLE (peer uuid, exact_shared integer, near_shared integer, best_near_bands integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH mine AS (
    SELECT exact, bands FROM core.content_fingerprints
     WHERE tenant_id = p_tenant AND day >= p_since AND trusted_by IS NULL
     ORDER BY last_seen_at DESC
     LIMIT 200
  ),
  exact AS (
    SELECT o.tenant_id AS peer, count(DISTINCT o.exact)::int AS n
      FROM core.content_fingerprints o JOIN mine m ON m.exact = o.exact
     WHERE o.tenant_id <> p_tenant AND o.day >= p_since AND o.trusted_by IS NULL
     GROUP BY o.tenant_id
  ),
  pairs AS (
    SELECT o.tenant_id AS peer, o.exact,
           cardinality(ARRAY(SELECT unnest(o.bands) INTERSECT SELECT unnest(m.bands))) AS shared
      FROM mine m
      JOIN core.content_fingerprints o
        ON o.bands && m.bands
       AND o.exact <> m.exact
     WHERE o.tenant_id <> p_tenant AND o.day >= p_since AND o.trusted_by IS NULL
  ),
  near AS (
    SELECT p.peer, count(DISTINCT p.exact)::int AS n, max(p.shared)::int AS best
      FROM pairs p WHERE p.shared >= 2
     GROUP BY p.peer
  )
  SELECT coalesce(e.peer, n.peer), coalesce(e.n, 0), coalesce(n.n, 0), n.best
    FROM exact e FULL JOIN near n ON n.peer = e.peer
   LIMIT 500
$$;
--> statement-breakpoint

-- content_neighbors, excluding trusted content on both sides, with the
-- evidence a finding records: every neighbour hit, their median and best
-- similarity. Still one row of numbers.
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
  best_similarity real
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
  tainted AS (SELECT tenant_id FROM core.risk_tainted_tenants())
  SELECT
    (SELECT count(*)::int FROM peers),
    (SELECT count(*)::int FROM peers p
       JOIN core.tenants t ON t.id = p.tenant_id
       LEFT JOIN core.plan_assignments a ON a.tenant_id = p.tenant_id
      WHERE t.created_at > now() - interval '30 days'
        AND coalesce(a.plan_id = p_free_plan, true)),
    (SELECT count(*)::int FROM peers p WHERE p.tenant_id IN (SELECT tenant_id FROM tainted)),
    (SELECT max(p.similarity) FROM peers p WHERE p.tenant_id IN (SELECT tenant_id FROM tainted)),
    (SELECT count(*)::int FROM hits),
    (SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY h.similarity))::real FROM hits h),
    (SELECT max(h.similarity) FROM hits h)
$$;
--> statement-breakpoint

-- behaviour_neighbors, with the median distance for the evidence.
DROP FUNCTION "core"."behaviour_neighbors"(uuid, integer);
--> statement-breakpoint
CREATE FUNCTION "core"."behaviour_neighbors"(p_tenant uuid, p_k integer)
RETURNS TABLE (
  labelled integer,
  abuse integer,
  legit integer,
  mean_abuse_distance real,
  nearest_distance real,
  median_distance real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, public, pg_temp
AS $$
  WITH me AS (SELECT embedding FROM core.behaviour_vectors WHERE tenant_id = p_tenant),
  latest AS (
    SELECT DISTINCT ON (l.tenant_id) l.tenant_id, l.label
      FROM core.risk_labels l
     WHERE l.tenant_id <> p_tenant
     ORDER BY l.tenant_id, l.labeled_at DESC
  ),
  nn AS (
    SELECT la.label, (b.embedding <-> me.embedding)::real AS distance
      FROM latest la
      JOIN core.behaviour_vectors b ON b.tenant_id = la.tenant_id
      CROSS JOIN me
     ORDER BY b.embedding <-> me.embedding
     LIMIT p_k
  )
  SELECT count(*)::int,
         (count(*) FILTER (WHERE label = 'abuse'))::int,
         (count(*) FILTER (WHERE label = 'legit'))::int,
         (avg(distance) FILTER (WHERE label = 'abuse'))::real,
         min(distance),
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY distance))::real
    FROM nn
$$;
--> statement-breakpoint

-- ⚠ FUNCTIONS ARE EXECUTABLE BY PUBLIC UNTIL REVOKED, and migration 0002's
-- default privileges grant EXECUTE on new `core` functions to i10_api. So:
-- revoke from PUBLIC by name, and grant i10_api exactly what it calls. Each
-- of these is called by the API, the hourly job or risk-admin, all of which
-- connect as i10_api.
REVOKE EXECUTE ON FUNCTION
  "core"."risk_boilerplate_list"(),
  "core"."risk_boilerplate_add"(text, text, jsonb, jsonb, text[], integer, integer, text, text, text, text),
  "core"."risk_boilerplate_remove"(uuid, text, text),
  "core"."risk_boilerplate_history"(integer),
  "core"."risk_boilerplate_nearest"(uuid, text, date),
  "core"."trusted_templates_pending"(),
  "core"."trusted_template_tenant"(uuid),
  "core"."fingerprint_peers"(uuid, date),
  "core"."content_neighbors"(uuid, text, date, real, text),
  "core"."behaviour_neighbors"(uuid, integer)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  "core"."risk_boilerplate_list"(),
  "core"."risk_boilerplate_add"(text, text, jsonb, jsonb, text[], integer, integer, text, text, text, text),
  "core"."risk_boilerplate_remove"(uuid, text, text),
  "core"."risk_boilerplate_history"(integer),
  "core"."risk_boilerplate_nearest"(uuid, text, date),
  "core"."trusted_templates_pending"(),
  "core"."trusted_template_tenant"(uuid),
  "core"."fingerprint_peers"(uuid, date),
  "core"."content_neighbors"(uuid, text, date, real, text),
  "core"."behaviour_neighbors"(uuid, integer)
TO i10_api;
