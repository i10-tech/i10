-- The roles and schemas the application expects, created once on an empty data
-- directory.
--
-- ⚠ `i10_api` IS NOT THE OWNER, AND THAT IS THE WHOLE REASON THIS FILE EXISTS.
-- Row level security does not apply to a table's owner: every tenant policy in
-- the `core` schema is a silent no-op for the role that created the tables. A
-- local database where the app connects as the owner is one where the tenant
-- boundary does not exist — so every RLS bug ships, because development could
-- never have shown it. `apps/api/src/db/client.ts` refuses to start against an
-- owning, superuser or BYPASSRLS role, which turns a subtle leak into a startup
-- failure; this file is what lets it start at all.
--
-- ⚠ THE PASSWORDS ARE WORTHLESS ON PURPOSE. This database listens on a laptop's
-- loopback and holds fixtures. A real secret here would be a real secret
-- committed to the repository.
CREATE ROLE i10_api LOGIN PASSWORD 'i10_api';
CREATE ROLE pdns LOGIN PASSWORD 'pdns';

GRANT CONNECT ON DATABASE i10 TO i10_api;
GRANT CONNECT ON DATABASE i10 TO pdns;

-- ⚠ THE SCHEMAS ARE CREATED HERE EVEN THOUGH MIGRATIONS ALSO CREATE THEM, and
-- the reason is the statement below. `ALTER DEFAULT PRIVILEGES IN SCHEMA` fails
-- outright on a schema that does not exist yet — so without these three lines
-- this script aborts, Postgres reports the initdb step as failed, and the
-- container comes up with no roles at all. Every migration uses
-- `CREATE SCHEMA IF NOT EXISTS`, so creating them early costs nothing.
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS authd;
CREATE SCHEMA IF NOT EXISTS pdns;

GRANT USAGE ON SCHEMA core, authd, pdns TO i10_api;
GRANT USAGE ON SCHEMA pdns TO pdns;

-- ⚠ DEFAULT PRIVILEGES APPLY TO WHAT IS CREATED *AFTERWARDS*, BY THIS ROLE.
-- Migrations run as `i10`, so everything they create lands granted — the same
-- mechanism migration 0002 relies on in production. A plain `GRANT ON ALL
-- TABLES` here would cover the zero tables that exist right now and nothing
-- else.
ALTER DEFAULT PRIVILEGES FOR ROLE i10 IN SCHEMA core, authd, pdns
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO i10_api;
ALTER DEFAULT PRIVILEGES FOR ROLE i10 IN SCHEMA core, authd, pdns
  GRANT USAGE, SELECT ON SEQUENCES TO i10_api;

-- The nameserver reads and writes only its own schema. See migration 0040 for
-- why it needs more than SELECT.
ALTER DEFAULT PRIVILEGES FOR ROLE i10 IN SCHEMA pdns
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pdns;
ALTER DEFAULT PRIVILEGES FOR ROLE i10 IN SCHEMA pdns
  GRANT USAGE, SELECT ON SEQUENCES TO pdns;
