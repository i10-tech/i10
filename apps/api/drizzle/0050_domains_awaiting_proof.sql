-- The domains nobody has proved yet, so that something tries again.
--
-- ⚠ `not_started` WAS A DEAD END WITH NO BACKGROUND EXIT, AND THAT IS THE WHOLE
-- REASON THIS EXISTS. Every other selector in this schema deliberately steps
-- over it: `core.domains_awaiting_provider` filters `status <> 'not_started'`
-- because it asks SES about identities and an unproved row has none, and
-- `core.domains_due_recheck` reads `status = 'verified'` because its job is
-- re-proving domains that already passed. Between them there was no reader at
-- all for the state EVERY domain is in the moment it is created.
--
-- ⚠ SO THE ONLY THING THAT EVER REGISTERED AN IDENTITY WAS A HUMAN. `verify` is
-- reachable from two HTTP routes and from nothing else, and the console fires
-- it exactly once — about a second after publishing the records. DNS is
-- frequently not serving yet at that instant, and on the manual path the
-- records go up hours later, so that one attempt missed and nothing ever made a
-- second one. The row sat `not_started` for ever while the console's own watch
-- polled `refresh`, which returns `not_registered` and writes nothing. The
-- customer's domain was stuck until somebody happened to press Verify again.
--
-- ⚠ IT SELECTS ON `status` AND `verified_at` BOTH, because they answer
-- different questions and the pair is what makes this safe to re-run. `status`
-- is the state machine; `verified_at` is the send gate's column and the record
-- that a domain has EVER worked. A row that has been verified is not waiting to
-- be proved, whatever its status has swung to since — that is
-- `domains_due_recheck`'s territory, and overlapping with it would mean two
-- sweeps writing the same rows.
--
-- ⚠ THE HORIZON IS A PARAMETER RATHER THAN A PREDICATE, for the same reason it
-- is one in 0049: "give up" is a policy and this is a selector. A domain
-- somebody abandoned half-way through a signup should stop costing DNS queries
-- eventually, and where that line falls is the caller's to decide.
CREATE FUNCTION "core"."domains_awaiting_proof"(
  p_before timestamptz,
  p_created_after timestamptz,
  p_limit int
)
RETURNS TABLE (
  domain_id uuid,
  tenant_id uuid,
  name text,
  delegated boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.id, d.tenant_id, d.name, d.delegated
    FROM core.domains d
   WHERE d.status = 'not_started'
     AND d.verified_at IS NULL
     AND d.created_at > p_created_after
     -- ⚠ THE STALENESS CLOCK ONLY TICKS BECAUSE `verify` NOW STAMPS IT ON AN
     -- UNPROVEN OUTCOME TOO. Before that change every unproven exit returned
     -- without touching the row, so this column stayed NULL for exactly the
     -- rows this function selects — and an oldest-first sweep would have taken
     -- the same head of the table on every single run while the rows behind it
     -- were never reached at all.
     AND (d.dns_checked_at IS NULL OR d.dns_checked_at < p_before)
   -- ⚠ OLDEST FIRST, so a run that hits the limit still makes progress through
   -- the whole table. The same reasoning as the other two selectors.
   ORDER BY d.dns_checked_at ASC NULLS FIRST
   LIMIT p_limit;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."domains_awaiting_proof"(timestamptz, timestamptz, int) TO i10_api;
