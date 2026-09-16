-- One route per domain could not say which mail it meant.
--
-- ⚠ `core.domains.delivery_route` HELD ONE VALUE AND A DOMAIN HAS TWO KINDS OF
-- MAIL LEAVING IT. What the API sends and what the domain's mailboxes send are
-- different products with different economics, and one column forced the same
-- answer on both — so a customer whose people send through our own MTA could
-- not also have their transactional traffic on SES. That control is the whole
-- reason the column exists. See docs/decisions/mail-routing.md.
--
-- ⚠ EXPAND, NOT RENAME, AND THE DIFFERENCE IS THE WIDTH OF A ROLLOUT.
-- `ALTER TABLE RENAME COLUMN` is instant DDL, but between this migration and
-- the last old pod terminating there are readers in flight that still name the
-- old column, and every one of them fails for that window. `core.messages` is
-- the billing record and the SES reconcilers read it on a schedule, so a column
-- disappearing under a running reconciler turns a repair pass into an error
-- pass. The old columns stay, backfilled and unread, and a later migration
-- drops them once nothing names them.

-- The route a message ACTUALLY took. Distinct from `delivery_route`, which is a
-- stored preference and may say `auto`.
--
-- ⚠ `auto` IS DELIBERATELY NOT A MEMBER. This type describes the past, and a
-- message that was sent went one way or the other. Reusing the override's type
-- would make `auto` representable on a row describing something that already
-- happened, and the reporting query that counts direct against SES would grow a
-- third bucket nobody meant to create.
CREATE TYPE "core"."sent_route" AS ENUM('ses', 'direct');
--> statement-breakpoint

ALTER TABLE "core"."domains"
  ADD COLUMN "transactional_route" "core"."delivery_route" DEFAULT 'auto' NOT NULL;
--> statement-breakpoint

ALTER TABLE "core"."domains"
  ADD COLUMN "mailbox_route" "core"."delivery_route" DEFAULT 'auto' NOT NULL;
--> statement-breakpoint

-- ⚠ EVERY EXISTING PREFERENCE WAS ABOUT API MAIL, BECAUSE API MAIL IS ALL THE
-- SEND PATH HAS EVER CARRIED. Copying it into `transactional_route` keeps a
-- support override that somebody set on a live domain applying to exactly the
-- traffic they set it for. `mailbox_route` deliberately does NOT inherit it:
-- nothing reads that column yet, and seeding it from a decision made about a
-- different kind of mail would be inventing an answer.
UPDATE "core"."domains" SET "transactional_route" = "delivery_route";
--> statement-breakpoint

ALTER TABLE "core"."messages"
  ADD COLUMN "provider_message_id" text;
--> statement-breakpoint

ALTER TABLE "core"."messages"
  ADD COLUMN "sent_route" "core"."sent_route";
--> statement-breakpoint

-- ⚠ HISTORY IS ALL SES, AND SAYING SO IS WHAT MAKES THE COLUMN USABLE. Leaving
-- `sent_route` null on old rows would make "how much went direct" answerable
-- only for messages sent after this migration, and every total would silently
-- exclude everything before it. SES was the only transport the worker had, so
-- the value is known rather than assumed — but only where we actually sent
-- something, which is what the predicate says.
--
-- ⚠ IDEMPOTENT, SO A RE-RUN IS CHEAP RATHER THAN A SECOND FULL REWRITE. The
-- `sent_route IS NULL` predicate means a migration replayed against a database
-- that already has it touches no rows at all, and lets the backfill be finished
-- out of band in batches if the table is ever big enough to matter.
--
-- ⚠ AND IT IS STILL ONE UNBOUNDED STATEMENT, WHICH IS A VOLUME BET RATHER THAN
-- AN OVERSIGHT. `core.messages` is the billing record, so at a few million rows
-- this rewrite and the index build below both block inserts for as long as they
-- run — with the deploy's PreSync hook holding the rollout behind them. Batching
-- it properly needs separate transactions, which a drizzle migration does not
-- get, and `CREATE INDEX CONCURRENTLY` cannot run inside one either. If this
-- table grows past comfortable, both move to a one-off job outside the
-- migration rather than growing a batching loop in here.
UPDATE "core"."messages"
   SET "provider_message_id" = "ses_message_id",
       "sent_route"          = 'ses'
 WHERE "status" = 'sent'
   AND "sent_route" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "messages_provider_id_idx"
  ON "core"."messages" USING btree ("provider_message_id");
--> statement-breakpoint

-- ⚠ THE REPAIR WRITES THE NEW COLUMN NOW, AND IT MUST WRITE BOTH. `0028`'s
-- version set `ses_message_id`; while the old column still exists, a repair
-- that filled only one of them would leave the pair disagreeing on a row the
-- reconciler had just touched — and the contract half of this function is that
-- the row it repairs is indistinguishable from one the worker wrote.
--
-- Everything else about it is unchanged and deliberately so: the guards stay
-- INSIDE the function because it is SECURITY DEFINER and runs with RLS
-- bypassed, `sent_at` still comes from SES's event rather than `now()` so a
-- repaired message is billed in the day it was sent, and the claim is still
-- cleared so the stale-claim sweep does not find a row it no longer owns.
--
-- ⚠ THE PARAMETER IS `p_sent_at` AND MUST STAY `p_sent_at`. `CREATE OR REPLACE
-- FUNCTION` refuses to rename an input parameter — it raises rather than
-- replacing — so a tidier name here would fail at deploy, inside a migration,
-- after the ALTERs above had already committed.
CREATE OR REPLACE FUNCTION "core"."repair_from_ses"(
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
     SET status              = 'sent',
         sent_at             = p_sent_at,
         ses_message_id      = coalesce(ses_message_id, p_ses_message_id),
         provider_message_id = coalesce(provider_message_id, p_ses_message_id),
         sent_route          = coalesce(sent_route, 'ses'),
         last_error          = null,
         claimed_by          = null,
         claimed_at          = null
   WHERE id = p_message_id
     AND created_at = p_created_at
     AND status <> 'sent'
  RETURNING id
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION "core"."repair_from_ses"(uuid, timestamptz, timestamptz, text) TO i10_api;
--> statement-breakpoint

-- ⚠ WITHOUT THIS PREDICATE EVERY DIRECT-ROUTED MESSAGE IS AN ALARM, FOREVER.
-- The snapshot finds rows we call `sent` for which no SES `sent` event ever
-- arrived. For a message our own MTA carried, no such event will EVER arrive —
-- that is not a discrepancy, it is the route working. Left as it was, the
-- reconciler would report the entire free tier as unconfirmed on every run and
-- the finding would stop meaning anything.
--
-- ⚠ `IS DISTINCT FROM` RATHER THAN `<>`, BECAUSE THE COLUMN IS NULLABLE. A row
-- still in flight has no route yet, and `sent_route <> 'direct'` is NULL for
-- it — which a WHERE clause treats as false, silently excluding exactly the
-- rows most likely to be worth reporting.
CREATE OR REPLACE FUNCTION "core"."ses_unconfirmed_snapshot"(
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
     AND m.sent_route IS DISTINCT FROM 'direct'
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
