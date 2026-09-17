-- How much mail left by which route.
--
-- ⚠ `sent_route` HAS BEEN WRITTEN SINCE 0033 AND READ BY NOTHING. Every `sent`
-- row records the MTA that carried it, which is exactly the record the routing
-- decision promised to keep — and until now the only way to ask "how much went
-- direct" was to open a psql session and write the query by hand. A column
-- nobody can read is a column that quietly stops being correct.
--
-- ⚠ AND THE QUESTION IS OURS, NOT THE CUSTOMER'S. Both routes meter identically
-- and bill at one price; the split is what decides how much SES we are buying
-- and how much of our own IP reputation we are spending. Publishing it on the
-- customer API would make the route visible in the product, which is the one
-- thing the per-domain lever exists to prevent — so this is a privileged
-- function for the reconciler and for whoever has psql, and it stops there.
--
-- ⚠ `SECURITY DEFINER` FOR THE SAME REASON `sent_usage_snapshot` IS. Every
-- policy in `core` reads `current_setting('app.tenant_id')` strictly, so a
-- cross-tenant count issued from a job raises `unrecognized configuration
-- parameter` on its first statement rather than returning nothing. Same shape,
-- same narrowness: counts and ids, never an address, a subject or a body.
--
-- ⚠ IT SCANS EVERY PARTITION IN RANGE AND DOES NOT PRUNE, WHICH IS A PROPERTY
-- RATHER THAN A FAULT. `core.messages` is partitioned by `created_at`; this
-- filters on `sent_at`, so Postgres appends across all of them — measured on the
-- live plan, which walks `messages_2026_09`, `_10` and `_11` for a one-day
-- window. `sent_usage_snapshot` has exactly the same shape for exactly the same
-- reason: acceptance is not delivery, and bucketing on `created_at` would file a
-- message accepted at 23:59 and sent at 00:01 in the wrong day. This runs once a
-- day in a CronJob, so the scan is affordable and the correct clock is not
-- negotiable.
CREATE FUNCTION "core"."route_split_snapshot"(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  tenant_id uuid,
  period_start timestamp,
  route text,
  count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT m.tenant_id,
         date_trunc('day', m.sent_at AT TIME ZONE 'UTC'),
         -- ⚠ `unknown` RATHER THAN COALESCING INTO `ses`, AND THE DIFFERENCE IS
         -- THE WHOLE VALUE OF THIS ROW. `sent_route` is nullable: 0033 backfilled
         -- the rows that existed and `markSentStatement` has written it on every
         -- row since, so a `sent` message with no route is a FAULT — a write path
         -- that skipped it, or a repair that did not set it. Folding those into
         -- `ses` would make the fault add up to a plausible number and disappear.
         coalesce(m.sent_route::text, 'unknown'),
         count(*)
    FROM core.messages m
   WHERE m.status = 'sent'
     AND m.sent_at >= p_from
     AND m.sent_at <  p_to
   GROUP BY 1, 2, 3
$$;
--> statement-breakpoint

-- ⚠ THE SAME GRANT THE OTHER SNAPSHOTS CARRY. `i10_api` is the role the API and
-- every job connect as; without this the function exists and nothing may call it,
-- which fails at runtime rather than here.
GRANT EXECUTE ON FUNCTION "core"."route_split_snapshot"(timestamptz, timestamptz) TO i10_api;
