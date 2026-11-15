-- Finding bodies to pack and packs to sweep (#188). The design is
-- docs/decisions/storage.md, "Bodies to R2".
--
-- ⚠ TENANT IDS ONLY, NEVER CONTENT, like 0076 and 0082. The jobs run as
-- `i10_api`; these tell them which workspaces have work, and the work itself
-- runs per tenant, under RLS, through `withTenant`.

-- Workspaces with bodies still inline that were written before `p_before`:
-- the candidates for a pack. The job decides per workspace, under RLS, which
-- are finished and examined, and whether enough is waiting to be worth a write.
-- `message_bodies_unpacked_idx` makes this a walk over inline bodies only.
CREATE FUNCTION "core"."content_pack_due"(p_limit integer, p_before timestamptz)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT DISTINCT b.tenant_id
    FROM core.message_bodies b
   WHERE b.pack_id IS NULL
     AND b.compacted_at IS NULL
     AND (b.html IS NOT NULL OR b.text IS NOT NULL)
     AND b.created_at < p_before
   LIMIT p_limit
$$;
--> statement-breakpoint

-- 0076's list, plus workspaces holding a pack older than the grace: every pack
-- is eventually swept, once retention has removed the last body pointing at it.
CREATE OR REPLACE FUNCTION "core"."content_sweep_due"(p_grace interval)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT o.tenant_id FROM core.content_objects o
   WHERE o.last_seen_at < now() - p_grace
  UNION
  SELECT t.tenant_id FROM core.content_templates t
   WHERE t.last_seen_at < now() - p_grace
  UNION
  SELECT p.tenant_id FROM core.content_packs p
   WHERE p.created_at < now() - p_grace
$$;
