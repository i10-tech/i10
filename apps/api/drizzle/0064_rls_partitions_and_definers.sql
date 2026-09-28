-- Closes two tenant-isolation gaps found by the 2026-09-28 RLS audit (#212).
--
-- ⚠ 1. PARTITIONS NEVER HAD ROW LEVEL SECURITY. `core.messages`,
-- `core.message_bodies` and `core.message_events` are partitioned by month, and
-- RLS on a partitioned table applies only when a query goes through the
-- PARENT. Every partition was a plain table with no policy that `i10_api` could
-- read and write directly, so `select * from core.messages_2026_09` returned
-- every tenant's mail. Nothing in the code names a partition, so this took a
-- SQL injection or a mistake to reach - which is exactly what RLS is for.
--
-- Both halves, because either alone leaves a way back in: the policy makes a
-- direct query tenant-scoped even if a grant reappears, and the revoke means a
-- direct query is refused before a policy is consulted at all. Access through
-- the parent needs privileges on the parent only, so the app is unaffected.
--
-- ⚠ EVERY PARTITION IN `core`, NOT THREE NAMED PARENTS. A fourth partitioned
-- table added later must not start life with the same hole.
DO $$
DECLARE
  part regclass;
BEGIN
  FOR part IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'core'
       AND c.relispartition
       AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', part);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy WHERE polrelid = part AND polname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %s '
        'USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)',
        part
      );
    END IF;
    EXECUTE format('REVOKE ALL ON %s FROM i10_api', part);
  END LOOP;
END $$;
--> statement-breakpoint

-- ⚠ 2. EVERY SECURITY DEFINER FUNCTION IN `core` WAS EXECUTABLE BY PUBLIC.
-- Postgres grants EXECUTE to PUBLIC on every new function, and the migrations
-- that made them added an explicit `i10_api` grant on top without taking the
-- PUBLIC one away. Most other roles cannot reach `core` at all, but 0056 gave
-- `stalwart` USAGE on the schema for `mailbox_route` - and USAGE plus PUBLIC
-- EXECUTE let the mail server call `terminate_tenant`, `provision_tenant`,
-- `resolve_api_key` and the rest, each running as the owner with RLS bypassed.
--
-- `i10_api` keeps what it could already call, by explicit grant rather than
-- through PUBLIC; `stalwart` keeps `mailbox_route`, which 0036 granted it by
-- name and is untouched here.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA core FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core TO i10_api;
--> statement-breakpoint

-- ⚠ AND THE DEFAULT, SO THE NEXT FUNCTION DOES NOT REOPEN IT. The PUBLIC grant
-- on functions is a GLOBAL default, and Postgres does not let a per-schema
-- default revoke a global one - so the revoke is global for the owner role, and
-- the per-schema grant keeps every future `core` function callable by the API
-- without each migration having to remember it.
ALTER DEFAULT PRIVILEGES FOR ROLE i10 REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE i10 IN SCHEMA core GRANT EXECUTE ON FUNCTIONS TO i10_api;
