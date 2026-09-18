-- A domain name is exclusive once somebody PROVES they own it, not when
-- somebody first types it.
--
-- ⚠ THE OLD CONSTRAINT LET A STRANGER LOCK A DOMAIN THEY DO NOT OWN. `name` was
-- globally unique across every tenant, so the first account to type
-- `spotify.com` held it for ever — including an account that never published a
-- single DNS record. The real owner then signed up, added their own domain and
-- was told "That domain is already registered", with no way forward: they
-- cannot see the other row, cannot delete it, and support cannot tell the two
-- apart either. A free signup was a denial-of-service against any domain in the
-- world, and it cost nothing to mount.
--
-- ⚠ VERIFICATION IS THE RIGHT GATE BECAUSE IT IS THE ONLY PROOF WE HAVE. An
-- unverified row asserts nothing — anyone can type any name — so it must not
-- exclude anybody. A verified row required publishing DKIM and a return path in
-- that domain's DNS, which only whoever controls the domain can do. So the
-- exclusion follows the proof.
--
-- ⚠ AND THE RACE RESOLVES ITSELF, IN THE ONLY DIRECTION THAT IS SAFE. Two
-- tenants may both hold `example.com` as pending; the index below means the
-- first to verify wins and the second's UPDATE to 'verified' fails with 23505.
-- `domainStore.verify` catches exactly that and reports `conflict`, which is
-- true: somebody else proved ownership first. Nothing is granted on a tie.
CREATE UNIQUE INDEX "domains_verified_name_unique"
    ON "core"."domains" ("name")
 WHERE "status" = 'verified';
--> statement-breakpoint

-- ⚠ THE PER-TENANT CONSTRAINT HAS TO EXIST BEFORE THE GLOBAL ONE GOES, or
-- dropping it lets one workspace add the same domain twice — two rows, two DKIM
-- keys, two sets of records for one name, and a customer with no way to tell
-- which of the identical rows is the one that verified.
ALTER TABLE "core"."domains"
    ADD CONSTRAINT "domains_tenant_name_unique" UNIQUE ("tenant_id", "name");
--> statement-breakpoint

-- ⚠ NAMED FROM `information_schema` RATHER THAN GUESSED. Postgres derives a
-- column-level UNIQUE constraint's name as <table>_<column>_key, but this table
-- has been through enough migrations that trusting the derivation would make
-- this statement fail on exactly the deployments that need it most. The DO
-- block drops whatever unique constraint actually covers `name` alone.
DO $$
DECLARE
    constraint_name text;
BEGIN
    SELECT c.conname INTO constraint_name
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'core'
       AND t.relname = 'domains'
       AND c.contype = 'u'
       AND c.conkey = ARRAY[
             (SELECT a.attnum FROM pg_attribute a
               WHERE a.attrelid = t.oid AND a.attname = 'name')
           ]::smallint[];

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE core.domains DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;
