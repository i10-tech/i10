-- Similarity, velocity and confirmed taint for the risk engine (#170).
--
-- ⚠ THE FEEDBACK-LOOP RULE (docs/decisions/risk.md): no score may feed another
-- score. Until now a workspace "linked to a held workspace" was penalised -
-- and a hold can be the score's own automatic action, still awaiting review.
-- Workspace A held by the score -> B critical by association -> B held -> C,
-- a cascade built entirely out of the engine agreeing with itself. So linkage
-- now counts only CONFIRMED abuse: a hold staff placed, a hold staff upheld, or
-- an abuse label staff gave. Observations and human verdicts in; scores never.

-- The workspaces confirmed abusive. Read only by the definers below.
--
-- ⚠ REVOKED FROM i10_api BY NAME, NOT MERELY LEFT UNGRANTED. Migration 0002's
-- default privileges grant EXECUTE on every new `core` function to i10_api, so
-- "not granted" does not exist here without an explicit revoke - the first
-- version of this file said "not granted" and i10_api could call it.
CREATE FUNCTION "core"."risk_tainted_tenants"()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT h.tenant_id FROM core.sending_holds h WHERE h.source = 'staff'
  UNION
  SELECT e.tenant_id FROM core.sending_hold_events e
   WHERE e.action = 'release' AND e.outcome = 'upheld'
     AND e.occurred_at > now() - interval '180 days'
  UNION
  SELECT l.tenant_id FROM core.risk_labels l
   WHERE l.label = 'abuse' AND l.source IN ('staff', 'hold_upheld')
     AND l.labeled_at > now() - interval '180 days'
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."risk_tainted_tenants"() FROM PUBLIC, i10_api;
--> statement-breakpoint

-- identity_profile, with "held" now meaning confirmed.
CREATE OR REPLACE FUNCTION "core"."identity_profile"(p_user text, p_since timestamptz)
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
  held_subnet_peers integer
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
    (SELECT count(*)::int FROM subnet_peers p JOIN tainted_owners h USING (clerk_user_id))
$$;
--> statement-breakpoint

-- risk_peer_profile, with `held` now meaning confirmed.
CREATE OR REPLACE FUNCTION "core"."risk_peer_profile"(
  p_tenant uuid,
  p_peers uuid[],
  p_free_plan text
)
RETURNS TABLE (
  peer uuid,
  free boolean,
  held boolean,
  young boolean,
  created_near boolean,
  same_owner boolean,
  owner_device boolean,
  owner_subnet boolean,
  owner_country boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH me AS (
    SELECT t.id, t.created_at, t.owner_clerk_user_id AS owner
      FROM core.tenants t WHERE t.id = p_tenant
  ),
  my_devices AS (
    SELECT DISTINCT e.device_id FROM core.identity_events e, me
     WHERE e.clerk_user_id = me.owner AND e.device_id IS NOT NULL
  ),
  my_subnets AS (
    SELECT DISTINCT e.subnet FROM core.identity_events e, me
     WHERE e.clerk_user_id = me.owner AND e.subnet IS NOT NULL
  ),
  my_countries AS (
    SELECT DISTINCT e.country FROM core.identity_events e, me
     WHERE e.clerk_user_id = me.owner AND e.country IS NOT NULL
  ),
  tainted AS (SELECT tenant_id FROM core.risk_tainted_tenants())
  SELECT
    t.id,
    coalesce(a.plan_id = p_free_plan, true),
    t.id IN (SELECT tenant_id FROM tainted),
    t.created_at > now() - interval '30 days',
    abs(extract(epoch FROM (t.created_at - me.created_at))) < 6 * 3600,
    t.owner_clerk_user_id = me.owner,
    EXISTS (SELECT 1 FROM core.identity_events e
             WHERE e.clerk_user_id = t.owner_clerk_user_id
               AND e.device_id IN (SELECT device_id FROM my_devices)),
    EXISTS (SELECT 1 FROM core.identity_events e
             WHERE e.clerk_user_id = t.owner_clerk_user_id
               AND e.subnet IN (SELECT subnet FROM my_subnets)),
    EXISTS (SELECT 1 FROM core.identity_events e
             WHERE e.clerk_user_id = t.owner_clerk_user_id
               AND e.country IN (SELECT country FROM my_countries))
    FROM core.tenants t
    CROSS JOIN me
    LEFT JOIN core.plan_assignments a ON a.tenant_id = t.id
   WHERE t.id = ANY(p_peers) AND t.id <> p_tenant
$$;
--> statement-breakpoint

-- tenants_sharing_parent, with `held` now meaning confirmed.
CREATE OR REPLACE FUNCTION "core"."tenants_sharing_parent"(p_parents text[], p_exclude uuid)
RETURNS TABLE (parent text, tenant_id uuid, held boolean, dead boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT DISTINCT p.parent, d.tenant_id,
         d.tenant_id IN (SELECT x.tenant_id FROM core.risk_tainted_tenants() x),
         t.status <> 'active'
    FROM unnest(p_parents) AS p(parent)
    JOIN core.domains d
      ON (d.name = p.parent OR d.name LIKE '%.' || p.parent)
    JOIN core.tenants t ON t.id = d.tenant_id
   WHERE d.tenant_id <> p_exclude
     AND d.verified_at IS NOT NULL
$$;
--> statement-breakpoint

-- How close this workspace's recent mail is to other workspaces' mail.
--
-- ⚠ ONE ROW OF NUMBERS, NEVER ANOTHER WORKSPACE'S VECTORS OR IDS. For each of
-- this workspace's recent vectors (the newest 50), its nearest neighbours from
-- OTHER workspaces through the HNSW index; then: how many distinct workspaces
-- sent something this close, how many of those are young and free, how many
-- are confirmed abusive, and the closest a confirmed abuser came.
--
-- ⚠ ITERATIVE SCAN (pgvector 0.8), because the neighbour list is filtered
-- afterwards (other workspace, same model, recent); without it a filter can
-- empty the top-k and the answer is silently "nothing similar".
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
  best_tainted_similarity real
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
     ORDER BY created_at DESC LIMIT 50
  ),
  near AS (
    SELECT DISTINCT n.tenant_id, n.similarity
      FROM mine m
      CROSS JOIN LATERAL (
        SELECT o.tenant_id, (1 - (o.embedding <=> m.embedding))::real AS similarity
          FROM core.content_vectors o
         WHERE o.model = p_model AND o.day >= p_since AND o.tenant_id <> p_tenant
         ORDER BY o.embedding <=> m.embedding
         LIMIT 20
      ) n
     WHERE n.similarity >= p_min_similarity
  ),
  peers AS (
    SELECT n.tenant_id, max(n.similarity) AS similarity FROM near n GROUP BY n.tenant_id
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
    (SELECT max(p.similarity) FROM peers p WHERE p.tenant_id IN (SELECT tenant_id FROM tainted))
$$;
--> statement-breakpoint

-- Whom this workspace behaves like, among workspaces a person or the world
-- has labelled (#170).
--
-- ⚠ LABELLED NEIGHBOURS ONLY, AND LABELS ARE OUTCOMES, NOT SCORES. The latest
-- label per workspace; distances are L2 between standardised feature vectors.
CREATE FUNCTION "core"."behaviour_neighbors"(p_tenant uuid, p_k integer)
RETURNS TABLE (labelled integer, abuse integer, legit integer, mean_abuse_distance real, nearest_distance real)
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
         min(distance)
    FROM nn
$$;
--> statement-breakpoint

-- How fast the person behind a workspace, and everyone sharing their device or
-- network, is creating things (#170: velocity as a first-class signal).
--
-- ⚠ THE ACTOR, NOT THE ACCOUNT. `foo+1@`, `foo+2@`... on one laptop are one
-- actor; each new account looks clean alone, and the burst only shows when
-- they are counted together.
CREATE FUNCTION "core"."actor_velocity"(p_owner text)
RETURNS TABLE (
  linked_people integer,
  workspaces_24h integer,
  workspaces_7d integer,
  linked_workspaces integer,
  linked_tainted integer,
  domains_24h integer,
  keys_24h integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH mine AS (
    SELECT DISTINCT device_id, subnet FROM core.identity_events
     WHERE clerk_user_id = p_owner AND occurred_at > now() - interval '30 days'
  ),
  people AS (
    SELECT p_owner AS clerk_user_id
    UNION
    SELECT DISTINCT e.clerk_user_id FROM core.identity_events e
     WHERE e.occurred_at > now() - interval '30 days'
       AND (e.device_id IN (SELECT device_id FROM mine WHERE device_id IS NOT NULL)
            OR e.subnet IN (SELECT subnet FROM mine WHERE subnet IS NOT NULL))
  ),
  ws AS (
    SELECT t.id, t.created_at FROM core.tenants t
     WHERE t.owner_clerk_user_id IN (SELECT clerk_user_id FROM people)
       AND t.status = 'active'
  )
  SELECT
    (SELECT count(*)::int FROM people),
    (SELECT count(*)::int FROM ws WHERE created_at > now() - interval '24 hours'),
    (SELECT count(*)::int FROM ws WHERE created_at > now() - interval '7 days'),
    (SELECT count(*)::int FROM ws),
    (SELECT count(*)::int FROM ws WHERE id IN (SELECT tenant_id FROM core.risk_tainted_tenants())),
    (SELECT count(*)::int FROM core.domains d
      WHERE d.tenant_id IN (SELECT id FROM ws) AND d.created_at > now() - interval '24 hours'),
    (SELECT count(*)::int FROM core.api_keys k
      WHERE k.tenant_id IN (SELECT id FROM ws) AND k.created_at > now() - interval '24 hours')
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION
  "core"."content_neighbors"(uuid, text, date, real, text),
  "core"."behaviour_neighbors"(uuid, integer),
  "core"."actor_velocity"(text)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  "core"."content_neighbors"(uuid, text, date, real, text),
  "core"."behaviour_neighbors"(uuid, integer),
  "core"."actor_velocity"(text)
TO i10_api;
