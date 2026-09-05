CREATE TABLE "core"."tenant_storage" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"bytes" bigint NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."tenant_storage" ADD CONSTRAINT "tenant_storage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ⚠ A NEW TABLE IN `core` IS NOT PROTECTED UNTIL THIS RUNS, and nothing fails
-- while it is not. Without it every tenant can read every other tenant's
-- storage figure — which is a usage disclosure, not just a number.
ALTER TABLE "core"."tenant_storage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "core"."tenant_storage"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint

-- Every mailbox the sampler has to ask about, grouped by who owns it.
--
-- ⚠ CROSS-TENANT, SO A SECURITY DEFINER FUNCTION — the sampling job holds no
-- tenant context. It reads `authd.accounts`, which has no row level security of
-- its own, so this is about the job being able to ask one question rather than
-- about a policy standing in its way.
--
-- ⚠ AND IT SKIPS MAILBOXES WITH NO TENANT. i10's own addresses on i10.tech
-- predate tenancy and belong to no customer; billing them to somebody would be
-- worse than not counting them.
CREATE FUNCTION "core"."tenant_mailboxes"()
RETURNS TABLE (
  tenant_id uuid,
  email text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, authd, pg_temp
AS $$
  SELECT a.tenant_id, a.email
    FROM authd.accounts a
   WHERE a.tenant_id IS NOT NULL
   ORDER BY a.tenant_id
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."tenant_mailboxes"() TO i10_api;
