-- Row level security for the two webhook tables.
--
-- ⚠ A NEW TABLE IN `core` IS NOT PROTECTED UNTIL THIS RUNS, AND NOTHING FAILS
-- WHILE IT IS NOT. `0002_tenancy` enabled RLS on the tables that existed then;
-- a table added later starts life readable by every tenant, and the only symptom
-- is one customer seeing another's endpoints. Grants come for free — the
-- `ALTER DEFAULT PRIVILEGES` in 0002 covers tables the owner creates from then
-- on — but policies do not, so every migration that adds a table to `core` must
-- add its policy in the same migration.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['webhook_endpoints', 'webhook_deliveries'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON core.%I '
      'USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)',
      tbl
    );
  END LOOP;
END $$;

--> statement-breakpoint
-- Who owns the message an SES event is about.
--
-- ⚠ A CHICKEN-AND-EGG THAT ONLY THE OWNER CAN BREAK. Every policy in `core`
-- reads `app.tenant_id`, and an SES notification does not carry one — it
-- carries our message id, in a tag, and nothing else that identifies a tenant.
-- So the ingestion path cannot set the tenant before it knows it, and cannot
-- know it without a query that the tenant setting gates.
--
-- The same shape as `sweep_stuck_messages`, and treated the same way: one
-- narrow question, answered by the owner, returning the minimum. It takes an id
-- and returns a tenant — it cannot be turned into "show me another tenant's
-- mail", because the caller must already hold a message id that SES echoed back
-- to us.
--
-- ⚠ AND IT RETURNS `created_at`, WHICH IS NOT A CONVENIENCE. `core.messages` is
-- partitioned on it and keyed `(id, created_at)`; without it every later
-- statement in the ingestion path would have to scan every partition.
--
-- ⚠ AND IT TAKES A RANGE, FOR THE SAME REASON THE STATUS ENDPOINT DERIVES ONE.
-- A lookup by bare id has to touch every partition that has ever existed, and
-- this runs several times per email sent — once per SES event. The caller knows
-- the window without a query: the id is a UUIDv7 and carries its own creation
-- millisecond, so a range around it prunes to a single partition. The bounds
-- are the caller's, and a caller that cannot date an id passes the widest range
-- it likes rather than getting a wrong answer.
CREATE FUNCTION "core"."message_owner"(msg_id uuid, from_ts timestamptz, to_ts timestamptz)
RETURNS TABLE (tenant_id uuid, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT m.tenant_id, m.created_at
    FROM core.messages m
   WHERE m.id = msg_id
     AND m.created_at >= from_ts
     AND m.created_at <= to_ts
   LIMIT 1;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."message_owner"(uuid, timestamptz, timestamptz) TO i10_api;
