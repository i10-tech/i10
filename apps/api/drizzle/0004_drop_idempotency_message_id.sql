-- `Idempotency-Key` becomes a batch answer, not a single-message one.
--
-- ⚠ A DROP RATHER THAN A CAST, BECAUSE THE COLUMN HAS NEVER BEEN WRITTEN TO.
-- `POST /emails` returned 501 until the accept path was wired, so there is no
-- data to preserve and `uuid -> uuid[]` needs no USING clause. If that ever
-- stops being true, this pair of migrations must become
-- `ALTER … TYPE uuid[] USING array[message_id]` instead — dropping a populated
-- column would silently turn every stored replay into a second send.
ALTER TABLE "core"."idempotency_keys" DROP COLUMN "message_id";
