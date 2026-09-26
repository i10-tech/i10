-- One return path for both routes.
--
-- ⚠ SES AND THE RELAY NOW WRITE THE SAME ENVELOPE SENDER, `<label>.<domain>`
-- (`mail_from_subdomain`, default `send`), and its SPF record authorises both —
-- see `returnPathDomain` in src/domains/zone.ts. The second label, with its MX
-- pointed at us, existed only so late bounces for mail we delivered ourselves
-- could come back; SES pins the return path's MX to Amazon, so the two could
-- not share a name. They do now, and those late bounces are the price.
--
-- ⚠ AND NOTHING DEPENDS ON THE COLUMN. Checked against production before this
-- was written: no view, rule or function reads `bounce_subdomain`, and no
-- function returns `core.domains` rows whole.

ALTER TABLE "core"."domains" DROP COLUMN "bounce_subdomain";
--> statement-breakpoint

-- The orphan sweep's zone names.
--
-- ⚠ THE SHAPES CHANGED, SO THE MATCH HAD TO. 0052 recognised exactly
-- `_domainkey.<d>`, `mail.<d>` and `_dmarc.<d>`. A delegated domain now
-- delegates its return path by its own name — `send.<d>`, or whatever label
-- the customer chose — so a fixed prefix list would never see the zone behind
-- a deleted domain with a custom label, and would keep matching a `mail.` shape
-- nothing issues any more.
--
-- ⚠ EVERY SHAPE WE ISSUE IS ONE LABEL ON TOP OF THE DOMAIN, so stripping the
-- first label recovers `<d>` for all of them — the old `mail.<d>` included,
-- which is how zones left over from before this change still get found. The
-- safety property is unchanged: a zone is reported only when NO workspace
-- anywhere holds a domain row for the recovered name, and `pdns` holds nothing
-- this codebase did not write.
CREATE OR REPLACE FUNCTION "core"."orphaned_zones"(p_limit int)
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
      CASE
        WHEN position('.' in z.name) > 0
          THEN substring(z.name from position('.' in z.name) + 1)
      END AS domain_name
      FROM pdns.domains z
  )
  SELECT o.zone_id, o.zone_name, o.domain_name
    FROM ours o
   -- ⚠ A NAME WITH NO LABEL TO STRIP IS NOT A SHAPE WE ISSUE.
   WHERE o.domain_name IS NOT NULL
     AND o.domain_name <> ''
     AND NOT EXISTS (
       SELECT 1 FROM core.domains d WHERE d.name = o.domain_name
     )
   ORDER BY o.zone_name
   LIMIT p_limit;
$$;
