-- The application role's access to the `identity` schema (#337).
--
-- ⚠ THE ONE PART OF THE SCHEMA DRIZZLE CANNOT MODEL. 0134 is generated; GRANT
-- is not something drizzle-kit writes, and 0002's default privileges cover
-- `core` only, so without this `i10_api` cannot see a single identity table.
-- Row level security still applies to every row it can see (0134's policies).
GRANT USAGE ON SCHEMA identity TO i10_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO i10_api;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO i10_api;
