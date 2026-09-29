-- Finding content work for the content-store job, across every workspace
-- (#171). The design is docs/decisions/storage.md.
--
-- ⚠ TENANT IDS ONLY, NEVER CONTENT, like everything in 0076. The job runs as
-- `i10_api`; these tell it which workspaces have work, and the work itself runs
-- per tenant, under RLS, through `withTenant`.
--
-- ⚠ EVERY WORKSPACE, WHATEVER ITS STATUS. Compaction used to ride the risk
-- run, which visits only active workspaces and never the system tenant - and
-- the system tenant's sign-in codes are the most templated mail we send.

-- Workspaces with finished bodies the compaction pass has not examined since
-- `p_since`, or with linked bodies whose template has reached `p_promote_at`.
--
-- ⚠ FINISHED ONLY IN THE FIRST HALF. A workspace with a week of scheduled mail
-- has unexamined bodies the pass must not touch yet; listing it would spend a
-- slot of `p_limit` on a workspace with nothing to do, every five minutes.
CREATE FUNCTION "core"."content_compaction_due"(
  p_limit integer,
  p_since timestamptz,
  p_promote_at integer
)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  (
    SELECT b.tenant_id
      FROM core.message_bodies b
      JOIN core.messages m ON m.id = b.message_id AND m.created_at = b.created_at
     WHERE b.examined_at IS NULL
       AND b.compacted_at IS NULL
       AND b.created_at > p_since
       AND m.status IN ('sent', 'failed', 'canceled')
    UNION
    SELECT b.tenant_id
      FROM core.message_bodies b
      JOIN core.content_templates t ON t.id = b.template_id
     WHERE b.template_id IS NOT NULL
       AND b.compacted_at IS NULL
       AND t.messages >= p_promote_at
  )
  LIMIT p_limit
$$;
--> statement-breakpoint

-- Workspaces with bodies not fingerprinted since `p_since`, whatever their
-- status: accept used to fingerprint every message, queued or not.
CREATE FUNCTION "core"."content_fingerprint_due"(p_limit integer, p_since timestamptz)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT DISTINCT b.tenant_id
    FROM core.message_bodies b
   WHERE b.fingerprinted_at IS NULL
     AND b.created_at > p_since
   LIMIT p_limit
$$;
--> statement-breakpoint

-- ⚠ EVERY BODY THAT EXISTS NOW WAS ALREADY FINGERPRINTED, AT ACCEPT. Until this
-- release the API did it after the write; left unmarked, the job's first pass
-- would count a week of mail a second time into `content_fingerprints` and
-- `link_hosts`, doubling every workspace's numbers the farm checks read. Mail
-- accepted by an old API pod in the minutes between this migration and the
-- rollout is the one overlap, and it is counted twice once.
UPDATE core.message_bodies SET fingerprinted_at = created_at WHERE fingerprinted_at IS NULL;
