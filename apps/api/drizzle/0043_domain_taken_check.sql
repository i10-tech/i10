-- Is this name already verified by somebody else? A boolean, and nothing else.
--
-- ⚠ WITHOUT IT, REFUSING A DUPLICATE COSTS THE OTHER TENANT THEIR DKIM KEY.
-- `domainStore.create` calls SES before it inserts the row, because the row
-- stores the status SES reports — so a create that is about to be refused by
-- `domains_verified_name_unique` has ALREADY called `CreateEmailIdentity`. SES
-- identities are keyed on the domain name in one AWS account, so that call does
-- not create anything: it raises `AlreadyExistsException`, and the adapter's
-- recovery is `PutEmailIdentityDkimSigningAttributes` — which REPLACES the
-- signing key of whoever owns the name with the newcomer's.
--
-- The verified tenant then signs with a key their DNS does not publish, every
-- signature fails, SES re-checks and marks the identity failed, and their
-- working domain breaks. All of it caused by a stranger typing the name into a
-- form and being told no.
--
-- ⚠ AND IT CANNOT BE ASKED WITHOUT THIS FUNCTION, WHICH IS THE ONLY REASON IT
-- EXISTS. `core.domains` is under row level security, so a tenant's own query
-- for "does anybody else hold this" returns nothing by construction. The same
-- shape as `core.message_owner` and `core.tenant_for_principal`: one narrow
-- question, answered by the owner, returning the minimum.
--
-- ⚠ IT RETURNS A BOOLEAN AND NEVER THE HOLDER. `create`'s refusal is already
-- careful not to say "Acme Ltd already has example.com", because that would
-- turn the endpoint into a way to ask which domains are customers of ours. A
-- function that returned a tenant id would put that back.
CREATE FUNCTION "core"."domain_verified_elsewhere"(p_name text, p_tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM core.domains
     WHERE name = p_name
       AND status = 'verified'
       AND tenant_id <> p_tenant
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."domain_verified_elsewhere"(text, uuid) TO i10_api;
