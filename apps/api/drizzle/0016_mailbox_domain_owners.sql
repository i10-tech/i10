-- Which domains may host mailboxes, and whose they are.
--
-- ⚠ THIS IS THE FUNCTION THAT REPLACES `MAIL_DOMAINS` FOR CUSTOMER DOMAINS.
-- That variable is one global list for the whole deployment, correct only while
-- i10.tech is the only domain we host. Once a customer hosts mailboxes, "may
-- this address become a local recipient" has a per-tenant answer and has to be
-- a query. The variable stays for i10's own domains, which predate tenancy and
-- own no row.
--
-- ⚠ `verified_at IS NOT NULL` IS A SECURITY BOUNDARY, NOT A TIDINESS FILTER.
-- A row in this result makes Stalwart treat the domain as a LOCAL RECIPIENT —
-- it accepts and stores mail addressed to it. Returning an unverified domain
-- would let anyone who typed a name they do not own start receiving that
-- domain's mail. Verification is what makes the claim mean anything, and
-- `core.domains.name` being globally unique is what stops a second tenant
-- claiming a verified one.
--
-- ⚠ AND IT IS DELIBERATELY NOT THE SAME QUESTION AS THE DOMAIN LIMIT. A limit
-- counts what EXISTS, verified or not, because an unverified domain is still a
-- row the customer created and can see. This asks what may be ACTED ON, and
-- only a verified domain may be. Two questions, two predicates, and conflating
-- them either lets a tenant park unlimited pending domains or lets an
-- unverified one receive mail.
--
-- Cross-tenant, so a SECURITY DEFINER function for the same reason as
-- `subscriptions_snapshot` and `active_tenants_snapshot`: the Clerk webhook
-- that reads this holds no tenant context, and it returns only a name the
-- caller is about to be told anyway plus the id that owns it.
CREATE FUNCTION "core"."mailbox_domains"()
RETURNS TABLE (
  name text,
  tenant_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.name, d.tenant_id
    FROM core.domains d
   WHERE d.hosts_mailboxes
     AND d.verified_at IS NOT NULL
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."mailbox_domains"() TO i10_api;
--> statement-breakpoint

-- Counting mailboxes per tenant needs an index on the column that was never
-- written until now.
CREATE INDEX IF NOT EXISTS "accounts_tenant_idx"
  ON "authd"."accounts" USING btree ("tenant_id");
--> statement-breakpoint

-- Attribute the rows that already exist.
--
-- ⚠ A NO-OP ON A DEPLOYMENT WHOSE ONLY MAILBOXES ARE i10's OWN, and that is the
-- expected outcome rather than a sign it did not run. Addresses on i10.tech
-- have no `core.domains` row, so they stay NULL — which the column allows, on
-- purpose, because inventing an owner for them would be worse than admitting
-- they have none.
UPDATE authd.accounts a
   SET tenant_id = d.tenant_id
  FROM core.domains d
 WHERE a.tenant_id IS NULL
   AND d.hosts_mailboxes
   AND d.verified_at IS NOT NULL
   AND lower(split_part(a.email, '@', 2)) = lower(d.name);
