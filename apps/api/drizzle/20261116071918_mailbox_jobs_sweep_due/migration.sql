-- What the hourly retention job sweeps in `core.mailbox_jobs` (#392), across
-- every workspace at once: jobs whose worker was lost, and archives in R2 that
-- nobody is going to use again.
--
-- ⚠ THE SWEEP USED TO RUN ONLY WHEN A JOB OF THE SAME WORKSPACE STARTED, so a
-- workspace that never ran another job kept an expired export, or a plain,
-- unsealed import upload, forever. It needs every workspace's rows, and
-- `mailbox_jobs` is under row-level security whose policy casts
-- `app.tenant_id` to uuid, which fails with no tenant set.
--
-- HAND-WRITTEN BECAUSE DRIZZLE CANNOT MODEL A FUNCTION, on the pattern of
-- `identity.expiry_tenants_due`: SECURITY DEFINER functions that answer ids
-- and object keys only. Every write after this goes through the tenant.
--
-- Keyset paging by job id (uuidv7); `p_limit` is capped so one call cannot ask
-- for all.
--
-- `mailbox_jobs_lost`: a job `running` with no progress for `p_stale`. groupmq
-- runs it with `maxAttempts: 1`, so a worker killed mid-job fails it in Redis
-- without our handler, and the row would say `running` forever and block the
-- console for that mailbox. A live job touches `updated_at` with every
-- progress write; the caller picks `p_stale` far past its longest silence.
CREATE FUNCTION "core"."mailbox_jobs_lost"(p_after uuid, p_stale interval, p_limit integer)
RETURNS TABLE (tenant_id uuid, job_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT j.tenant_id, j.id
    FROM core.mailbox_jobs j
   WHERE j.status = 'running'
     AND j.updated_at < now() - p_stale
     AND (p_after IS NULL OR j.id > p_after)
   ORDER BY j.id
   LIMIT least(greatest(p_limit, 0), 500)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."mailbox_jobs_lost"(uuid, interval, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."mailbox_jobs_lost"(uuid, interval, integer) TO i10_api;
--> statement-breakpoint
-- `mailbox_archives_due`: rows whose archive should go now, and rows of a
-- workspace whose tenant row is gone. A row with an `object_key` is due when:
--
--   - it is an export past `expires_at`, seven days after it completed;
--   - it is an import that `completed` or `failed`. The worker deletes these
--     itself, so any left are due now; this is also what deletes a lost job's
--     upload right after `mailbox_jobs_lost` has failed it;
--   - it is an import that has not moved for `p_import_keep`: an upload that
--     was never started;
--   - its workspace is deleted, or its tenant row is gone, and it is an export
--     or has not moved for `p_upload_window`.
--
-- ⚠ THE UPLOAD WINDOW IS FOR A PRESIGNED PUT STILL IN FLIGHT. Its URL works
-- for that long, so an upload can land after we delete; waiting the window out
-- means no object can reappear after `object_key` is cleared, with nothing
-- left that knows it exists. An export's object only exists once its job
-- completes, so there is no such race for an export.
--
-- ⚠ A WORKSPACE WHOSE TENANT ROW IS GONE COUNTS AS DELETED, as in
-- `template_assets_orphaned`. `mailbox_jobs` has no foreign key to `tenants`,
-- so its rows outlive a tenant row removed by hand. Such a row with no
-- `object_key` left is due itself, for the caller to delete, unless it is
-- `pending` or `running`: that job may still write an object and set
-- `object_key`, so it waits until it ends or is failed as lost.
CREATE FUNCTION "core"."mailbox_archives_due"(
  p_after uuid,
  p_import_keep interval,
  p_upload_window interval,
  p_limit integer
)
RETURNS TABLE (tenant_id uuid, job_id uuid, object_key text, tenant_gone boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT j.tenant_id, j.id, j.object_key, (t.id IS NULL)
    FROM core.mailbox_jobs j
    LEFT JOIN core.tenants t ON t.id = j.tenant_id
   WHERE (p_after IS NULL OR j.id > p_after)
     AND (
       (j.object_key IS NOT NULL AND (
          (j.type = 'export' AND j.expires_at < now())
          OR (j.type = 'import' AND j.status IN ('completed', 'failed'))
          OR (j.type = 'import' AND j.updated_at < now() - p_import_keep)
          OR ((t.id IS NULL OR t.status = 'deleted')
              AND (j.type = 'export' OR j.updated_at < now() - p_upload_window))
       ))
       OR (t.id IS NULL
           AND j.object_key IS NULL
           AND j.status NOT IN ('pending', 'running'))
     )
   ORDER BY j.id
   LIMIT least(greatest(p_limit, 0), 500)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."mailbox_archives_due"(uuid, interval, interval, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."mailbox_archives_due"(uuid, interval, interval, integer) TO i10_api;
