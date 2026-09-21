-- The zones we are still serving for domains that no longer exist.
--
-- ⚠ NOTHING HAS EVER LOOKED, AND DELETES HAVE BEEN FAILING SILENTLY THE WHOLE
-- TIME. `remove` tidies the zones behind a deleted domain and is allowed to
-- fail doing it — deliberately, because the row is already gone and a 500 the
-- customer cannot act on is worse than a leak. Every one of those failures is a
-- zone left in `pdns` answering for a domain nobody owns, with a DKIM key and a
-- return path in it, and the only record is a log line.
--
-- ⚠ AND THE GUARD ABOVE IT WAS WRONG FOR EVERY OLD DOMAIN UNTIL 0051. Zones
-- used to be published by `create`, before claims existed, so a delegated
-- domain from before that change has three live zones and no row in
-- `core.delegations` — and the old `holdsZones` read that as "not mine" and
-- left them. This function is how the ones already stranded get found.
--
-- ⚠ IT MATCHES ONLY THE THREE NAMES WE ISSUE, AND THAT IS THE SAFETY PROPERTY.
-- `delegatedZoneNames` produces exactly `_domainkey.<d>`, `mail.<d>` and
-- `_dmarc.<d>`; a zone in `pdns` that is not one of those shapes is not ours to
-- reason about and is never returned, whatever else is in that database. The
-- prefix is stripped to recover `<d>`, and the zone is orphaned only when NO
-- workspace anywhere holds a domain row for that name.
--
-- ⚠ `NOT EXISTS` OVER EVERY TENANT, NOT THIS ONE. A zone is in use if ANYBODY
-- holds the name — several workspaces may hold one name as pending, and the
-- zone belongs to whichever of them is being served. Scoping this per tenant
-- would report a live zone as an orphan and delete somebody's mail routing.
CREATE FUNCTION "core"."orphaned_zones"(p_limit int)
RETURNS TABLE (
  zone_id bigint,
  zone_name text,
  domain_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pdns, pg_temp
AS $$
  WITH ours AS (
    SELECT
      z.id::bigint AS zone_id,
      z.name       AS zone_name,
      -- ⚠ THE OFFSET IS COMPUTED, NOT COUNTED BY HAND. `_domainkey.` is eleven
      -- characters and `_dmarc.` is seven, and getting either off by one
      -- silently yields a name that matches no domain row — which would report
      -- every zone as an orphan and delete all of them.
      CASE
        WHEN z.name LIKE '\_domainkey.%'
          THEN substring(z.name from length('_domainkey.') + 1)
        WHEN z.name LIKE 'mail.%'
          THEN substring(z.name from length('mail.') + 1)
        WHEN z.name LIKE '\_dmarc.%'
          THEN substring(z.name from length('_dmarc.') + 1)
      END AS domain_name
      FROM pdns.domains z
  )
  SELECT o.zone_id, o.zone_name, o.domain_name
    FROM ours o
   -- ⚠ NOT ONE OF OUR THREE SHAPES: not ours, not our business.
   WHERE o.domain_name IS NOT NULL
     AND o.domain_name <> ''
     AND NOT EXISTS (
       SELECT 1 FROM core.domains d WHERE d.name = o.domain_name
     )
   ORDER BY o.zone_name
   LIMIT p_limit;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."orphaned_zones"(int) TO i10_api;
--> statement-breakpoint
-- Which of these names this database still knows about.
--
-- ⚠ THE ORPHAN SWEEP ASKS SES WHAT EXISTS AND HAS TO SUBTRACT WHAT SHOULD. That
-- subtraction spans every tenant, so it cannot be a request-scoped read: row
-- level security makes another workspace's domains invisible, and a sweep that
-- asked directly would be told that every OTHER customer's live sending
-- identity is an orphan and delete all of them. This is the single most
-- dangerous query in the feature and it is why this function exists.
--
-- ⚠ IT TAKES THE NAMES AND RETURNS THE KNOWN ONES, rather than returning every
-- domain in the table. The sweep only ever needs the intersection, the input is
-- already bounded by what SES reported, and handing back the full customer
-- domain list to something that does not need it is how a narrow definer
-- function turns into a general-purpose read of the whole table.
CREATE FUNCTION "core"."domains_known"(p_names text[])
RETURNS TABLE (name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT DISTINCT d.name
    FROM core.domains d
   WHERE d.name = ANY(p_names);
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."domains_known"(text[]) TO i10_api;
