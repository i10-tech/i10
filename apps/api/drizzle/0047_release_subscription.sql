-- Taking a Polar subscription id off the tenant that no longer owns it.
--
-- ⚠ `polar_subscription_id` IS UNIQUE ON PURPOSE AND STAYS THAT WAY. Two
-- tenants pointing at one subscription is one payment entitling two accounts,
-- and the reconciler — which matches on that id — would flip the plan back and
-- forth between them on every pass. This does not relax the constraint; it
-- moves the id, atomically, to the tenant that actually bought.
--
-- ⚠ IT EXISTS BECAUSE THE RECLAIM OTHERWISE DEADLOCKS ON THAT CONSTRAINT.
-- Polar deduplicates customers by email and stamps `external_id` only when it
-- CREATES one, so somebody who deletes their account and signs up again keeps
-- a customer naming their old tenant. The signature-verified webhook therefore
-- binds the brand-new subscription to the OLD tenant seconds before the
-- post-checkout page tries to bind it to the live one — and that insert dies on
-- the unique index, is swallowed, and the customer's plan never arrives.
-- Observed in production 2026-09-20 on a customer holding seven subscriptions,
-- every one of them attributed to a tenant that no longer existed.
--
-- ⚠ SECURITY DEFINER BECAUSE THE CALLER IS SCOPED TO THE NEW TENANT AND THE ROW
-- BELONGS TO THE OLD ONE. Under `core.subscriptions`'s policy the losing row is
-- invisible, so a plain DELETE would report success having deleted nothing —
-- the exact silent failure this is meant to end. Same shape as
-- `provision_tenant` and `terminate_tenant`, and the same rule: one narrow
-- question, answered by the owner, returning the minimum.
--
-- ⚠ AND IT REFUSES TO TOUCH THE CLAIMANT'S OWN ROW. Called with the tenant that
-- already holds the id, it deletes nothing and answers 0 — so an ordinary
-- repeat of a grant cannot destroy the row it is about to update.
CREATE FUNCTION "core"."release_subscription"(
  p_polar_subscription_id text,
  p_to_tenant_id uuid
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_released integer;
BEGIN
  DELETE FROM core.subscriptions s
   WHERE s.polar_subscription_id = p_polar_subscription_id
     AND s.tenant_id IS DISTINCT FROM p_to_tenant_id;

  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."release_subscription"(text, uuid) TO i10_api;
