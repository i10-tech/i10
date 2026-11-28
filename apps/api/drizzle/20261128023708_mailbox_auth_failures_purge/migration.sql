SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- ⚠ THE 90-DAY RULE FOR MAILBOX SIGN-IN FAILURES (#388). The whole row goes,
-- raw IP and all: nothing reads past a short window, and deleting bounds the
-- table's growth. The caller passes the cutoff (now - 90 days).
--
-- ⚠ THE FUNCTION ENFORCES ITS OWN BOUNDS, because it deletes across every
-- workspace. The cutoff is never later than now() - 90 days, so a caller bug
-- (or a stolen i10_api session) passing now() or 'infinity' cannot wipe recent
-- brute-force evidence. A NULL cutoff deletes nothing. The batch is clamped to
-- 0..10000, so a NULL or huge p_limit cannot become one unbounded delete.
--
-- ⚠ BATCHED: AT MOST p_limit ROWS PER CALL, OLDEST FIRST. The runner calls it
-- in small batches, each its own statement, so a backlog never becomes one
-- long delete holding row locks and writing WAL in one go. The pick is a range
-- on `mailbox_auth_failures_occurred_idx`.
--
-- ⚠ SKIP LOCKED: two runs at once (a manual job beside the hourly one) take
-- different rows instead of queueing on the same ones, and a workspace delete
-- cascading through the same rows is skipped rather than deadlocked against.
--
-- ⚠ `id = ANY (ARRAY(...))`, NOT `id IN (SELECT ...)`. The IN form is planned
-- as a hash semi join over a SEQ SCAN of the whole table, so its cost grows
-- with the table while the batch stays fixed. The array is computed once and
-- the rows are found through the primary key, so the cost follows the batch.
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
  WITH picked AS MATERIALIZED (
    SELECT id FROM core.mailbox_auth_failures
     WHERE p_before IS NOT NULL
       AND occurred_at < LEAST(p_before, now() - interval '90 days')
     ORDER BY occurred_at
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 0), 0), 10000)
       FOR UPDATE SKIP LOCKED
  ),
  purged AS (
    DELETE FROM core.mailbox_auth_failures
     WHERE id = ANY (ARRAY(SELECT id FROM picked))
    RETURNING 1
  )
  SELECT count(*)::int FROM purged
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION "core"."mailbox_auth_failures_purge"(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION "core"."mailbox_auth_failures_purge"(timestamptz, integer) TO i10_api;
