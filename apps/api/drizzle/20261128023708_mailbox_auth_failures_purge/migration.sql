-- ⚠ THE 90-DAY RULE FOR MAILBOX SIGN-IN FAILURES (#388). The whole row goes,
-- raw IP and all: nothing reads past a short window, and deleting bounds the
-- table's growth. The caller passes the cutoff (now - 90 days).
--
-- ⚠ BATCHED: AT MOST p_limit ROWS PER CALL, OLDEST FIRST. Each hourly risk run
-- deletes a bounded amount, so a backlog drains over several runs instead of
-- one long delete holding row locks and writing WAL in one go. The inner
-- SELECT is a range on `mailbox_auth_failures_occurred_idx`.
--
-- ⚠ `id = ANY (ARRAY(...))`, NOT `id IN (SELECT ...)`. The IN form is planned
-- as a join, and on a backlog the planner hashes the batch and SEQ SCANS the
-- whole table to find its rows: 3,449 extra buffers at 200k rows, growing with
-- the table while the batch stays 10,000. The array is computed once and the
-- rows are found through the primary key, so the cost follows the batch.
--
-- SECURITY DEFINER because the table's RLS policy is per workspace and this
-- deletes across all of them; i10_api alone may call it.
CREATE FUNCTION "core"."mailbox_auth_failures_purge"(p_before timestamptz, p_limit integer)
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH purged AS (
    DELETE FROM core.mailbox_auth_failures
     WHERE id = ANY (ARRAY(
       SELECT id FROM core.mailbox_auth_failures
        WHERE occurred_at < p_before
        ORDER BY occurred_at
        LIMIT p_limit
     ))
    RETURNING 1
  )
  SELECT count(*)::int FROM purged
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION "core"."mailbox_auth_failures_purge"(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION "core"."mailbox_auth_failures_purge"(timestamptz, integer) TO i10_api;
