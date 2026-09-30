-- GitHub-connected templates (#235): the questions a webhook has to ask before
-- it knows whose event it is. The design is docs/decisions/templates.md,
-- "GitHub-connected templates".
--
-- ⚠ IDS ONLY, like 0076, 0085 and 0092. GitHub's payload names an installation
-- and a repository, never a workspace; these map those to the workspaces that
-- connected them, and everything after runs per tenant, under RLS.

-- The workspace an installation belongs to, if any.
CREATE FUNCTION "core"."github_installation_owner"(p_installation bigint)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT i.tenant_id FROM core.github_installations i
   WHERE i.installation_id = p_installation
$$;
--> statement-breakpoint

-- Every live connection of one repository through one installation. The unique
-- installation makes that at most one row; the set shape keeps a caller from
-- assuming it.
CREATE FUNCTION "core"."github_connections"(p_installation bigint, p_repo bigint)
RETURNS TABLE (tenant_id uuid, repository_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT r.tenant_id, r.id FROM core.github_repositories r
   WHERE r.installation_id = p_installation
     AND r.repo_id = p_repo
     AND r.removed_at IS NULL
$$;
--> statement-breakpoint

-- Syncs left behind: pending for longer than `p_pending`, or running for
-- longer than `p_running` (the process that claimed it is gone).
CREATE FUNCTION "core"."github_syncs_due"(p_pending interval, p_running interval, p_limit integer)
RETURNS TABLE (tenant_id uuid, sync_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT s.tenant_id, s.id FROM core.github_syncs s
   WHERE (s.status = 'pending' AND s.created_at < now() - p_pending)
      OR (s.status = 'running' AND s.started_at < now() - p_running)
   ORDER BY s.created_at
   LIMIT p_limit
$$;
