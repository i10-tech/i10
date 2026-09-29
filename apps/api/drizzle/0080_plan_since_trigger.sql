-- `plan_since` moves when, and only when, a tenant's plan actually changes.
--
-- ⚠ A TRIGGER, NOT THE WRITERS. Plans change in at least three places: the
-- grant upsert (metering/postgres.ts `assignStatement`), `terminate_tenant`
-- (0046) dropping a deleted workspace to free, and whatever comes next. A
-- trigger cannot be forgotten by the next one, and it compares OLD with NEW,
-- so a re-grant of the plan already held (a redelivered Polar webhook) leaves
-- it alone - which is what keeps a replay from handing a free workspace a
-- fresh first-send window.

-- Existing rows: the column arrived as `now()`, which would bound every free
-- window to the deploy and hand everybody a fresh day. The last write to the
-- row is the best record of when its plan was set; for a tenant that never
-- changed plan it is no later than the day they joined.
-- ⚠ BEFORE THE TRIGGER EXISTS: this update leaves `plan_id` alone, so the
-- trigger would put the old value straight back.
UPDATE core.plan_assignments SET plan_since = updated_at;
--> statement-breakpoint

CREATE FUNCTION "core"."plan_assignments_plan_since"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
    NEW.plan_since := now();
  ELSE
    NEW.plan_since := OLD.plan_since;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "plan_assignments_plan_since"
BEFORE UPDATE ON "core"."plan_assignments"
FOR EACH ROW EXECUTE FUNCTION "core"."plan_assignments_plan_since"();
