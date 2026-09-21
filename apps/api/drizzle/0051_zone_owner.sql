-- Who a delegated domain's zones actually belong to.
--
-- ⚠ `remove` DECIDED THIS FROM `core.delegations` ALONE, AND FOR EVERY DOMAIN
-- THAT PREDATES THE CLAIM MECHANISM THE ANSWER WAS SILENTLY "NOBODY". Zones
-- used to be published by `create`, before a claim existed to be taken — the
-- comment in `create` that begins "NO ZONE IS PUBLISHED HERE ANY MORE" is the
-- fix that introduced claiming. Every delegated domain created before it has
-- zones in `pdns` and NO row in `core.delegations`, so the guard
--
--     holdsZones = delegated AND claim.domain_id = this row
--
-- reads `claim` as NULL and answers false. Deleting such a domain therefore
-- leaves all three of its zones behind, live, answering with a DKIM key and a
-- return path for a domain nobody owns — which is the same leak the missing
-- `ses:DeleteEmailIdentity` permission caused one layer up, with the same
-- symptom: the delete succeeds, the customer sees the domain gone, and our
-- nameservers go on serving it for ever.
--
-- ⚠ THE FIX CANNOT SIMPLY BE "NO CLAIM MEANS IT IS MINE", because that is the
-- cross-tenant hole the claim was invented to close. Several workspaces may
-- hold the same name as pending — migration 0039 allows exactly that, and the
-- note in `remove` records `pslhq.app` held by three tenants at once. If two of
-- them hold a claimless name, neither may take the zones away from the other.
--
-- ⚠ SO IT RETURNS BOTH FACTS AND LETS THE CALLER FAIL IN THE CHEAP DIRECTION.
-- A claim, when one exists, is authoritative and settles it. When none exists,
-- the zones are this row's only if this row is the ONLY holder of the name.
-- Leaving a zone behind costs an inert record that the next verify of that name
-- republishes wholesale; deleting one that is in use stops somebody's mail. So
-- anything ambiguous leaves it alone.
--
-- ⚠ AND IT IS A DEFINER FUNCTION BECAUSE THE QUESTION SPANS TENANTS. Row level
-- security makes the honest count impossible from a request — another tenant's
-- rows are invisible by construction, so asking directly would always answer
-- "I am the only holder" and hand every claimless name to whoever deleted
-- first. It returns a count and an id, never a tenant, so it cannot be used to
-- ask who else is a customer.
CREATE FUNCTION "core"."zone_owner"(p_name text)
RETURNS TABLE (
  /** The domain row holding the delegation claim, or NULL if nobody does. */
  claim_domain_id uuid,
  /** How many domain rows hold this name at all, across every workspace. */
  holders int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT
    (SELECT d.domain_id FROM core.delegations d WHERE d.name = p_name),
    (SELECT count(*)::int FROM core.domains dm WHERE dm.name = p_name);
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."zone_owner"(text) TO i10_api;
