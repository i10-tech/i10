-- The narrow cross-tenant questions the risk engine asks (#170).
--
-- ⚠ EVERY FUNCTION HERE EXISTS BECAUSE THE QUESTION SPANS WORKSPACES OR
-- PEOPLE, and row level security makes every other workspace invisible to
-- `i10_api`. The same rule as `tenants_known` and `domains_due_recheck`: one
-- narrow question, answered by the owner, returning the minimum - counts, ids
-- and booleans, never another person's raw IP or another workspace's content.
--
-- ⚠ `identity_events` AND `risk_models` HAVE A DENY-ALL POLICY. These
-- functions are the only way in or out of them. See docs/decisions/risk.md.

-- Which workspaces the hourly run scores: every live one.
CREATE FUNCTION "core"."risk_tenants_to_score"()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT t.id FROM core.tenants t WHERE t.status = 'active' ORDER BY t.id
$$;
--> statement-breakpoint

-- Records what we saw of a person. Returns the new row's id.
--
-- ⚠ THE WORKSPACE IS OPTIONAL AND UNCHECKED. It is a hint for staff, never an
-- authorisation, and a sign-in before provisioning has none.
CREATE FUNCTION "core"."record_identity_event"(
  p_user text,
  p_tenant uuid,
  p_kind text,
  p_session text,
  p_ip text,
  p_subnet text,
  p_country text,
  p_tor boolean,
  p_user_agent text,
  p_device text,
  p_timezone text,
  p_language text,
  p_detail jsonb
)
RETURNS uuid
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  INSERT INTO core.identity_events (
    clerk_user_id, tenant_id, kind, session_id, ip, subnet, country, tor,
    user_agent, device_id, timezone, language, detail
  ) VALUES (
    p_user, p_tenant, p_kind, p_session, p_ip, p_subnet, upper(p_country), p_tor,
    left(p_user_agent, 200), left(p_device, 64), left(p_timezone, 64),
    left(p_language, 35), p_detail
  )
  RETURNING id
$$;
--> statement-breakpoint

-- The person's most recent located session before now: what impossible travel
-- compares a new sighting against.
CREATE FUNCTION "core"."identity_last_located"(p_user text)
RETURNS TABLE (country text, session_id text, occurred_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT e.country, e.session_id, e.occurred_at
    FROM core.identity_events e
   WHERE e.clerk_user_id = p_user
     AND e.kind IN ('session', 'api_key')
     AND e.country IS NOT NULL
   ORDER BY e.occurred_at DESC
   LIMIT 1
$$;
--> statement-breakpoint

-- What the score needs to know about one person, as numbers.
--
-- ⚠ PEERS ARE COUNTED, NEVER NAMED. "Four other accounts used this device" is
-- the signal; which accounts is a staff question, answered by
-- `identity_linked_users`, which the score never calls.
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
    -- Other people whose FIRST sighting was within a day of this person's
    -- first, from the same network: accounts made together.
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
  held_owners AS (
    SELECT DISTINCT t.owner_clerk_user_id AS clerk_user_id
      FROM core.sending_holds h JOIN core.tenants t ON t.id = h.tenant_id
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
    (SELECT count(*)::int FROM device_peers p JOIN held_owners h USING (clerk_user_id)),
    (SELECT count(*)::int FROM subnet_peers),
    (SELECT count(*)::int FROM subnet_peers p JOIN held_owners h USING (clerk_user_id))
$$;
--> statement-breakpoint

-- Staff only (risk-admin): which people a person is linked to, and how.
CREATE FUNCTION "core"."identity_linked_users"(p_user text, p_since timestamptz)
RETURNS TABLE (clerk_user_id text, via text, shared integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT o.clerk_user_id, 'device', count(*)::int
    FROM core.identity_events o
   WHERE o.clerk_user_id <> p_user AND o.occurred_at >= p_since
     AND o.device_id IN (SELECT device_id FROM core.identity_events
                          WHERE clerk_user_id = p_user AND device_id IS NOT NULL)
   GROUP BY o.clerk_user_id
  UNION ALL
  SELECT o.clerk_user_id, 'subnet', count(*)::int
    FROM core.identity_events o
   WHERE o.clerk_user_id <> p_user AND o.occurred_at >= p_since
     AND o.subnet IN (SELECT subnet FROM core.identity_events
                       WHERE clerk_user_id = p_user AND subnet IS NOT NULL)
   GROUP BY o.clerk_user_id
$$;
--> statement-breakpoint

-- Sightings still waiting for their network to be looked up.
CREATE FUNCTION "core"."identity_unenriched"(p_limit integer)
RETURNS TABLE (id uuid, ip text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT e.id, e.ip FROM core.identity_events e
   WHERE e.asn IS NULL AND e.ip IS NOT NULL
     AND e.occurred_at > now() - interval '7 days'
   ORDER BY e.occurred_at DESC
   LIMIT p_limit
$$;
--> statement-breakpoint

CREATE FUNCTION "core"."identity_enrich"(
  p_id uuid,
  p_asn integer,
  p_as_name text,
  p_hosting boolean
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  UPDATE core.identity_events
     SET asn = p_asn, as_name = left(p_as_name, 120), hosting = p_hosting
   WHERE id = p_id
$$;
--> statement-breakpoint

-- ⚠ THE 90-DAY RULE FOR RAW IPS AND USER AGENTS. Derived fields stay.
CREATE FUNCTION "core"."identity_purge"(p_before timestamptz)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH purged AS (
    UPDATE core.identity_events
       SET ip = NULL, user_agent = NULL
     WHERE occurred_at < p_before AND (ip IS NOT NULL OR user_agent IS NOT NULL)
    RETURNING 1
  )
  SELECT count(*)::int FROM purged
$$;
--> statement-breakpoint

-- Other workspaces that sent the same content as this one since a day.
--
-- ⚠ EXACT AND NEAR ARE COUNTED APART. An exact match survives no edit; a near
-- match (two or more shared MinHash bands, see risk/fingerprint.ts) survives a
-- random token per message, which is the first thing a farm operator adds.
--
-- ⚠ BOTH ARE INDEX LOOKUPS, NOT A PAIRWISE SCAN: equality on `exact`, and a
-- GIN-served overlap (`&&`) on `bands` before the precise count. That is what
-- keeps this cheap however many workspaces there are.
CREATE FUNCTION "core"."fingerprint_peers"(p_tenant uuid, p_since date)
RETURNS TABLE (peer uuid, exact_shared integer, near_shared integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH mine AS (
    SELECT exact, bands FROM core.content_fingerprints
     WHERE tenant_id = p_tenant AND day >= p_since
     ORDER BY last_seen_at DESC
     LIMIT 200
  ),
  exact AS (
    SELECT o.tenant_id AS peer, count(DISTINCT o.exact)::int AS n
      FROM core.content_fingerprints o JOIN mine m ON m.exact = o.exact
     WHERE o.tenant_id <> p_tenant AND o.day >= p_since
     GROUP BY o.tenant_id
  ),
  near AS (
    SELECT o.tenant_id AS peer, count(DISTINCT o.exact)::int AS n
      FROM mine m
      JOIN core.content_fingerprints o
        ON o.bands && m.bands
       AND o.exact <> m.exact
       AND cardinality(ARRAY(SELECT unnest(o.bands) INTERSECT SELECT unnest(m.bands))) >= 2
     WHERE o.tenant_id <> p_tenant AND o.day >= p_since
     GROUP BY o.tenant_id
  )
  SELECT coalesce(e.peer, n.peer), coalesce(e.n, 0), coalesce(n.n, 0)
    FROM exact e FULL JOIN near n ON n.peer = e.peer
   LIMIT 500
$$;
--> statement-breakpoint

-- What a cluster needs to know about each peer workspace, relative to one.
--
-- ⚠ BOOLEANS, NOT THE PEER'S DATA. "Created within six hours of this one",
-- "its owner shares a device with this one's owner" - the linking features,
-- and nothing a staff member could not already see in the peer itself.
CREATE FUNCTION "core"."risk_peer_profile"(
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
  )
  SELECT
    t.id,
    coalesce(a.plan_id = p_free_plan, true),
    EXISTS (SELECT 1 FROM core.sending_holds h WHERE h.tenant_id = t.id),
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

-- Workspaces holding verified domains under the same registrable parents.
CREATE FUNCTION "core"."tenants_sharing_parent"(p_parents text[], p_exclude uuid)
RETURNS TABLE (parent text, tenant_id uuid, held boolean, dead boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT DISTINCT p.parent, d.tenant_id,
         EXISTS (SELECT 1 FROM core.sending_holds h WHERE h.tenant_id = d.tenant_id),
         t.status <> 'active'
    FROM unnest(p_parents) AS p(parent)
    JOIN core.domains d
      ON (d.name = p.parent OR d.name LIKE '%.' || p.parent)
    JOIN core.tenants t ON t.id = d.tenant_id
   WHERE d.tenant_id <> p_exclude
     AND d.verified_at IS NOT NULL
$$;
--> statement-breakpoint

-- How many live workspaces one person owns.
CREATE FUNCTION "core"."risk_owner_workspaces"(p_owner text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT count(*)::int FROM core.tenants t
   WHERE t.owner_clerk_user_id = p_owner AND t.status = 'active'
$$;
--> statement-breakpoint

-- Every label, for training. Features were frozen when the label was given.
CREATE FUNCTION "core"."risk_training_rows"()
RETURNS TABLE (tenant_id uuid, label text, weight real, features jsonb, labeled_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT l.tenant_id, l.label, l.weight, l.features, l.labeled_at
    FROM core.risk_labels l
   ORDER BY l.labeled_at
$$;
--> statement-breakpoint

CREATE FUNCTION "core"."risk_label_count"()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT count(*)::int FROM core.risk_labels
$$;
--> statement-breakpoint

-- The newest model, active or not, and the newest ACTIVE one.
CREATE FUNCTION "core"."risk_model_get"(p_active_only boolean)
RETURNS TABLE (id uuid, version integer, weights jsonb, evaluation jsonb, active boolean, trained_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT m.id, m.version, m.weights, m.evaluation, m.active, m.trained_at
    FROM core.risk_models m
   WHERE m.active OR NOT p_active_only
   ORDER BY m.version DESC
   LIMIT 1
$$;
--> statement-breakpoint

-- Saves a trained model. ⚠ AN ACTIVE ONE RETIRES EVERY OTHER, in one statement,
-- so there is never a moment with two models consulted.
CREATE FUNCTION "core"."risk_model_save"(p_weights jsonb, p_evaluation jsonb, p_active boolean)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_version integer;
BEGIN
  SELECT coalesce(max(version), 0) + 1 INTO v_version FROM core.risk_models;
  IF p_active THEN
    UPDATE core.risk_models SET active = false WHERE active;
  END IF;
  INSERT INTO core.risk_models (version, weights, evaluation, active)
  VALUES (v_version, p_weights, p_evaluation, p_active);
  RETURN v_version;
END;
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION
  "core"."risk_tenants_to_score"(),
  "core"."record_identity_event"(text, uuid, text, text, text, text, text, boolean, text, text, text, text, jsonb),
  "core"."identity_last_located"(text),
  "core"."identity_profile"(text, timestamptz),
  "core"."identity_linked_users"(text, timestamptz),
  "core"."identity_unenriched"(integer),
  "core"."identity_enrich"(uuid, integer, text, boolean),
  "core"."identity_purge"(timestamptz),
  "core"."fingerprint_peers"(uuid, date),
  "core"."risk_peer_profile"(uuid, uuid[], text),
  "core"."tenants_sharing_parent"(text[], uuid),
  "core"."risk_owner_workspaces"(text),
  "core"."risk_training_rows"(),
  "core"."risk_label_count"(),
  "core"."risk_model_get"(boolean),
  "core"."risk_model_save"(jsonb, jsonb, boolean)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  "core"."risk_tenants_to_score"(),
  "core"."record_identity_event"(text, uuid, text, text, text, text, text, boolean, text, text, text, text, jsonb),
  "core"."identity_last_located"(text),
  "core"."identity_profile"(text, timestamptz),
  "core"."identity_linked_users"(text, timestamptz),
  "core"."identity_unenriched"(integer),
  "core"."identity_enrich"(uuid, integer, text, boolean),
  "core"."identity_purge"(timestamptz),
  "core"."fingerprint_peers"(uuid, date),
  "core"."risk_peer_profile"(uuid, uuid[], text),
  "core"."tenants_sharing_parent"(text[], uuid),
  "core"."risk_owner_workspaces"(text),
  "core"."risk_training_rows"(),
  "core"."risk_label_count"(),
  "core"."risk_model_get"(boolean),
  "core"."risk_model_save"(jsonb, jsonb, boolean)
TO i10_api;
