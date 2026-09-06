-- The four questions and one repair that `send/reconcile-ses.ts` issues from a
-- job holding no tenant context.
--
-- ⚠ THE SAME DEFECT 0013 FIXED FOR THE USAGE RECONCILER, IN THE OTHER HALF OF
-- THE SAME JOB. Every policy in `core` reads `current_setting('app.tenant_id')`
-- strictly and only a `withTenant()` transaction sets it, so each of these
-- raised `unrecognized configuration parameter` on its first statement. 0013
-- gave the Autumn leg its snapshots and left the SES leg untouched; this is
-- that omission.
--
-- ⚠ AND IT FAILED LOUDLY, WHICH IS THE ONLY REASON IT WAS SURVIVABLE. A
-- reconciler that returned zero findings because RLS filtered every row would
-- have reported a clean account forever — the exact failure the file's own
-- comments call the worst possible one for a reconciler.
--
-- Held to 0013's rule: one narrow question each, answered by the owner,
-- returning the minimum. No address, subject or body — ids, timestamps and the
-- tenant the report already prints.
--
-- ⚠ THE GRACE IS A PARAMETER, NOT A LITERAL. `EVENT_GRACE` lives in
-- reconcile-ses.ts with the reasoning that sets it, and duplicating the value
-- here would let the two drift — at which point the job manufactures findings
-- and the comment explaining why it cannot is still true of the wrong number.

-- Messages SES accepted that our books do not count as sent.
--
-- ⚠ STABLE, so the planner runs it once rather than per output row.
CREATE FUNCTION "core"."ses_unbilled_snapshot"(p_grace interval, p_limit int)
RETURNS TABLE (
  message_id uuid,
  created_at timestamptz,
  tenant_id uuid,
  status text,
  ses_sent_at timestamptz,
  ses_message_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT m.id,
         m.created_at,
         m.tenant_id,
         m.status::text,
         e.occurred_at,
         e.payload ->> 'sesMessageId'
    FROM core.message_events e
    JOIN core.messages m
      ON m.id = e.message_id
   WHERE e.type = 'sent'
     AND e.occurred_at < now() - p_grace
     AND m.status <> 'sent'
   ORDER BY e.occurred_at
   LIMIT p_limit
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."ses_unbilled_snapshot"(interval, int) TO i10_api;
--> statement-breakpoint

-- Rows we call `sent` that SES has never confirmed.
CREATE FUNCTION "core"."ses_unconfirmed_snapshot"(
  p_from timestamptz,
  p_grace interval,
  p_limit int
)
RETURNS TABLE (
  message_id uuid,
  created_at timestamptz,
  tenant_id uuid,
  sent_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT m.id, m.created_at, m.tenant_id, m.sent_at
    FROM core.messages m
   WHERE m.status = 'sent'
     AND m.sent_at >= p_from
     AND m.sent_at <  now() - p_grace
     AND NOT EXISTS (
           SELECT 1
             FROM core.message_events e
            WHERE e.message_id = m.id
              AND e.type = 'sent'
         )
   ORDER BY m.sent_at
   LIMIT p_limit
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."ses_unconfirmed_snapshot"(timestamptz, interval, int) TO i10_api;
--> statement-breakpoint

-- Events naming a message that does not exist in our books at all.
CREATE FUNCTION "core"."ses_orphan_snapshot"(
  p_from timestamptz,
  p_grace interval,
  p_limit int
)
RETURNS TABLE (
  message_id uuid,
  tenant_id uuid,
  occurred_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT e.message_id, e.tenant_id, e.occurred_at
    FROM core.message_events e
   WHERE e.type = 'sent'
     AND e.occurred_at >= p_from
     AND e.occurred_at <  now() - p_grace
     AND NOT EXISTS (
           SELECT 1 FROM core.messages m WHERE m.id = e.message_id
         )
   ORDER BY e.occurred_at
   LIMIT p_limit
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."ses_orphan_snapshot"(timestamptz, interval, int) TO i10_api;
--> statement-breakpoint

-- The repair.
--
-- ⚠ THE ONLY ONE HERE THAT WRITES, AND ITS GUARDS LIVE INSIDE THE FUNCTION FOR
-- THAT REASON. A SECURITY DEFINER routine runs as the owner with RLS bypassed,
-- so anything the caller could omit is a row they could rewrite. `status <>
-- 'sent'` and the `created_at` match are not optimisations and not caller
-- courtesy — they are what stops this from being "set any message to sent at
-- any timestamp", which in a billing table is the whole of the damage.
--
-- ⚠ AND IT MUST NOT OVERWRITE A ROW THAT IS ALREADY `sent`. Two reconcilers, or
-- one retried, would otherwise rewrite `sent_at` and move the message into a
-- different billing bucket — turning a repair into a double-count in the usage
-- reconciler that reads this table next.
--
-- ⚠ `sent_at` COMES FROM SES'S EVENT, NOT FROM `now()`. The usage reconciler
-- buckets on `sent_at`; stamping the repair time would file a message in the
-- day it was noticed rather than the day it was sent, and every boundary would
-- then disagree with SES's own record of the same message.
--
-- ⚠ VOLATILE, NOT STABLE. It writes. The others do not.
CREATE FUNCTION "core"."repair_from_ses"(
  p_message_id uuid,
  p_created_at timestamptz,
  p_sent_at timestamptz,
  p_ses_message_id text
)
RETURNS TABLE (message_id uuid)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  UPDATE core.messages
     SET status         = 'sent',
         sent_at        = p_sent_at,
         ses_message_id = coalesce(ses_message_id, p_ses_message_id),
         last_error     = null,
         claimed_by     = null,
         claimed_at     = null
   WHERE id = p_message_id
     AND created_at = p_created_at
     AND status <> 'sent'
  RETURNING id
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."repair_from_ses"(uuid, timestamptz, timestamptz, text) TO i10_api;
