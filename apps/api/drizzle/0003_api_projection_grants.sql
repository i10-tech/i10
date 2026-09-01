-- The API writes the Clerk projection, and after moving off the owner role it
-- could not.
--
-- ⚠ THIS IS THE OTHER HALF OF THE NON-OWNER SWITCH. 0002 introduced `i10_api`
-- and granted it the `core` schema, because that is where row level security
-- lives and `core` was what the migration created. But the API also writes
-- `authd` — the Clerk webhook inserts into webhook_events and upserts accounts —
-- and while it connected as the `i10` owner those writes needed no grant at all.
-- The moment it stopped being the owner they became permission errors.
--
-- The symptom was not a permission error in any obvious place. Svix signature
-- verification passed, the handler ran, and the failure surfaced as
-- `clerk webhook failed` with the INSERT statement echoed back — which reads
-- like a broken query rather than a role that cannot see the schema. Clerk then
-- retried the delivery on its own schedule, so the projection stayed empty while
-- everything upstream reported success.
--
-- ⚠ NOT SYMMETRICAL WITH THE `authd` ROLE. That role gets SELECT and nothing
-- else, because services/authd only reads. This one writes, because the webhook
-- is the thing that maintains the projection in the first place.

GRANT USAGE ON SCHEMA authd TO i10_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA authd TO i10_api;
--> statement-breakpoint

-- Tables added by later migrations need the grant too. Without this a new table
-- is invisible to the API until someone remembers to re-grant, and the symptom
-- is a webhook that verifies, retries, and never lands.
ALTER DEFAULT PRIVILEGES IN SCHEMA authd
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO i10_api;
