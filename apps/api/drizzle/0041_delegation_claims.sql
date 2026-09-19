-- Who holds the DNS zones for a delegated domain.
--
-- ⚠ MIGRATION 0039 MOVED EXCLUSIVITY ONTO PROOF AND MISSED THE ONE PLACE WHERE
-- PROOF IS MANUFACTURED. It made `core.domains.name` free to type and exclusive
-- only once verified, which is right. But a DELEGATED domain is verified by SES
-- resolving `<selector>._domainkey.<domain>` — a lookup that follows the
-- customer's NS records into a zone WE serve. So writing a row into
-- `pdns.domains` is not a record of a claim; it is the act that produces the
-- proof the claim is later granted on.
--
-- ⚠ AND THE ZONE WAS WRITTEN ON `create`, UNVERIFIED, KEYED ON THE NAME ALONE.
-- `upsertZoneStatement` is `on conflict (name) do update`, so the second tenant
-- to add an already-delegated domain SILENTLY REPLACED the first tenant's zone
-- with their own DKIM selector — under NS records the real owner had published.
-- Their selector then resolved, SES verified them, and they could sign mail as
-- a domain they do not own, while the real owner's signing broke with correct
-- records and no error anywhere. `domains_verified_name_unique` does not catch
-- it: the victim is already verified, so it is the VICTIM who now looks like
-- the duplicate.
--
-- ⚠ THE DELETE HAD THE MIRROR OF IT. `remove` dropped the zones by name with no
-- ownership test, so any tenant holding a pending row for the name could delete
-- the DNS of whoever was actually serving it.
--
-- ⚠ SO THE ZONE GETS ITS OWN CLAIM, AND IT CANNOT FOLLOW VERIFICATION. Gating
-- publication on `status = 'verified'` is circular — nothing can verify until
-- its zone answers. This is therefore first-come, which reintroduces a bounded
-- version of the squat 0039 removed: a stranger can hold the DELEGATED mode for
-- a name they do not own. That is survivable where the old one was not. They
-- can never verify (SES reads the real owner's DNS, which does not point here),
-- they can never send, and the real owner keeps the manual record path — which
-- is the default and needs nothing from us. A name that cannot be delegated is
-- an inconvenience; a name somebody else can sign as is a takeover.
CREATE TABLE "core"."delegations" (
    -- The customer's domain, e.g. `example.com` — not the three zone names
    -- under it. They are derived from this one and always move together, so
    -- one row arbitrates all three and they cannot be claimed apart.
    "name" text NOT NULL,
    "domain_id" uuid NOT NULL,
    "tenant_id" uuid NOT NULL,
    "claimed_at" timestamptz NOT NULL DEFAULT now(),

    -- ⚠ NAMED, NOT LEFT TO POSTGRES. `domainStore.create` decides what to tell
    -- the customer by reading which constraint fired, and `delegations_pkey`
    -- is a name a future `ALTER` could change out from under that branch.
    CONSTRAINT "delegations_name_unique" PRIMARY KEY ("name"),

    -- One claim per domain row, so a retry cannot leave a tenant holding the
    -- same name twice through two different rows.
    CONSTRAINT "delegations_domain_unique" UNIQUE ("domain_id"),

    -- ⚠ CASCADE, SO DELETING THE DOMAIN RELEASES THE NAME. Without it the claim
    -- outlives the row that justified it and the squat becomes permanent for
    -- everybody including the person who made it.
    CONSTRAINT "delegations_domain_fk" FOREIGN KEY ("domain_id")
        REFERENCES "core"."domains"("id") ON DELETE CASCADE,
    CONSTRAINT "delegations_tenant_fk" FOREIGN KEY ("tenant_id")
        REFERENCES "core"."tenants"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "delegations_tenant_idx" ON "core"."delegations" ("tenant_id");
--> statement-breakpoint

-- ⚠ RLS IN THE SAME MIGRATION THAT ADDS THE TABLE — see 0009. A table added to
-- `core` later is readable by every tenant until a policy exists, and nothing
-- fails while it is not.
--
-- ⚠ AND IT DOES NOT WEAKEN THE CLAIM. A unique violation is raised for a row
-- the inserting tenant cannot SEE, so the exclusivity holds across the boundary
-- the policy draws. What the policy prevents is one tenant ENUMERATING which
-- domains other workspaces have delegated, which is the same thing the conflict
-- message is careful not to say out loud.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE core.delegations ENABLE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON core.delegations '
    'USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
    'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)';
END $$;
--> statement-breakpoint

-- ⚠ THE BACKFILL PICKS A WINNER RATHER THAN FAILING, because production already
-- has the collision this table exists to prevent: `pslhq.app` is held by three
-- tenants, two of them delegated, sharing one set of zones.
--
-- ⚠ VERIFIED FIRST, THEN OLDEST. A verified row has published records that
-- resolve, which means the zones in `pdns.domains` are almost certainly already
-- theirs — so giving the claim to anybody else would describe a state that is
-- not true and hand the next write to the wrong tenant. Arrival order only
-- decides between rows that have proved nothing either way.
INSERT INTO "core"."delegations" ("name", "domain_id", "tenant_id", "claimed_at")
SELECT DISTINCT ON (d."name")
       d."name", d."id", d."tenant_id", d."created_at"
  FROM "core"."domains" d
 WHERE d."delegated"
 ORDER BY d."name", (d."status" = 'verified') DESC, d."created_at" ASC;
