-- The replay answer for a batch: every id the key minted, in submission order.
--
-- Nullable only for the width of the inserting transaction. The row is written
-- before the messages so the primary key serialises two simultaneous retries of
-- the same key — the loser blocks on the uncommitted row, then reads the ids the
-- winner filled in here.
ALTER TABLE "core"."idempotency_keys" ADD COLUMN "message_ids" uuid[];
