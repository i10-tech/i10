-- The domains waiting on SES, so that something asks again.
--
-- ⚠ NOTHING EVER ASKED A SECOND TIME, AND A DOMAIN SES HAD VERIFIED SAT
-- `pending` IN OUR TABLE FOR EVER. `core.domains_due_recheck` — the only
-- background reader of this table — selects `WHERE status = 'verified'`,
-- because its job is re-proving ownership of domains that already passed. A
-- domain that has NOT passed is not in it, so the only things that ever move a
-- row from `pending` to `verified` are a human pressing Verify at the moment
-- Amazon happens to agree, and the console's own watch, which gives up after
-- about a minute.
--
-- ⚠ AND THE CONSEQUENCE WAS NOT COSMETIC. SES verifies on its own schedule and
-- tells nobody; once it has, it will happily send. So a customer's mail went
-- out and was delivered while our dashboard said the domain was pending — we
-- were simply wrong about our own state, for as long as the row lived. It also
-- makes the send gate dangerous: refusing on `verified_at` is only correct if
-- something keeps `verified_at` current.
--
-- ⚠ THE HORIZON IS A PARAMETER RATHER THAN A PREDICATE, because "give up" is a
-- policy and this is a selector. SES abandons DKIM verification after 72 hours,
-- so a domain older than that is not waiting on anything and asking about it
-- every five minutes spends an API call to be told the same thing for ever.
CREATE FUNCTION "core"."domains_awaiting_provider"(
  p_before timestamptz,
  p_created_after timestamptz,
  p_limit int
)
RETURNS TABLE (
  domain_id uuid,
  tenant_id uuid,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.id, d.tenant_id, d.name
    FROM core.domains d
   -- ⚠ `verified_at`, NOT `status`, AND IT IS THE SAME COLUMN THE SEND GATE
   -- READS. A domain that has ever been verified is not waiting on anybody:
   -- its status may swing to `temporary_failure` and back, and re-asking about
   -- those is `domains_due_recheck`'s job, not this one.
   WHERE d.verified_at IS NULL
     -- ⚠ AN IDENTITY MUST EXIST TO ASK ABOUT. `not_started` is the state of a
     -- row whose ownership has never been proved, so `CreateEmailIdentity` has
     -- never been called for it — asking SES would raise `NotFoundException`
     -- for every domain anybody ever abandoned half-way through.
     AND d.status <> 'not_started'
     AND d.created_at > p_created_after
     AND (d.dns_checked_at IS NULL OR d.dns_checked_at < p_before)
   -- ⚠ OLDEST FIRST, so a run that hits the limit makes progress through the
   -- whole table rather than re-checking the same head of it for ever. The
   -- same reasoning as `domains_due_recheck`.
   ORDER BY d.dns_checked_at ASC NULLS FIRST
   LIMIT p_limit;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."domains_awaiting_provider"(timestamptz, timestamptz, int) TO i10_api;
