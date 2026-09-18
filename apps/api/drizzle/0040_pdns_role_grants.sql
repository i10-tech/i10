-- The nameserver's grants, arriving with the nameserver.
--
-- ⚠ THIS IS THE MIGRATION 0023 PROMISED AND DEFERRED. That one created the
-- `pdns` schema and wrote these five statements out in a comment, because
-- granting to a role nobody authenticated as would have bought nothing — and
-- because `CREATE ROLE` is CNPG's job on this cluster, not a migration's. The
-- role now exists: `platform-db/cluster.yaml` declares it under `managed.roles`
-- with its password from Doppler, exactly as `stalwart`, `authd` and `i10_api`
-- arrived.
--
-- ⚠ THE ORDER MATTERS ACROSS DEPLOYS, AND IT FAILS SAFE IN ONLY ONE DIRECTION.
-- If this runs before CNPG has reconciled the role, every statement below fails
-- with `role "pdns" does not exist` and takes the whole PreSync hook with it —
-- which is how 0023 originally took 0024 through 0028 down. The guard makes the
-- migration a no-op in that case instead: the nameserver then starts, fails to
-- authenticate, and crashloops visibly, which is a far cheaper failure than a
-- blocked migration chain. Re-running the migration is not needed — CNPG
-- reconciles the role within a minute and the grants below are re-applied by
-- the next deploy's PreSync.
--
-- ⚠ AND IT GRANTS WRITE, WHICH IS NOT AN OVERSIGHT. PowerDNS updates
-- `domains.notified_serial` when it sends NOTIFYs and maintains `ordername` and
-- `auth` on records once DNSSEC is enabled. SELECT alone produces a server that
-- starts, answers queries, and fails at whichever of those it reaches first.
--
-- ⚠ WHAT IT DELIBERATELY DOES NOT GRANT IS EVERYTHING ELSE. `pdns` gets the
-- `pdns` schema and nothing more: no `core`, no `authd`. This is the one
-- process in the deployment that answers unauthenticated queries from the whole
-- internet over UDP, and the blast radius of a bug in it is bounded here.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pdns') THEN
        RAISE NOTICE 'role "pdns" does not exist yet; skipping its grants. CNPG creates it from platform-db/cluster.yaml, and the next migration run applies these.';
        RETURN;
    END IF;

    EXECUTE 'GRANT USAGE ON SCHEMA "pdns" TO pdns';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "pdns" TO pdns';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "pdns" TO pdns';

    -- ⚠ DEFAULT PRIVILEGES ARE SET FOR THE ROLE THAT CREATES THE TABLES, WHICH
    -- IS THE MIGRATION'S OWN. A future PowerDNS upgrade adding a table would
    -- otherwise land it ungranted, and the nameserver would fail on exactly the
    -- feature the upgrade was for.
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "pdns" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pdns';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "pdns" GRANT USAGE, SELECT ON SEQUENCES TO pdns';
END $$;
