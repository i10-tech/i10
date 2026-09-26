-- The rest of what `stalwart` needs to call `core.mailbox_route`.
--
-- ⚠ 0036 GRANTED EXECUTE AND NOTHING ELSE, AND EXECUTE ALONE IS NOT ENOUGH.
-- Resolving `core.mailbox_route` checks USAGE on the schema before it ever
-- reaches the function's own privileges, and `SECURITY DEFINER` does not help:
-- it changes who the body runs as, not who is allowed to find it. Without this
-- grant every `sql_query` from Stalwart's route expression fails with
-- "permission denied for schema core".
--
-- ⚠ THAT FAILURE IS SILENT, WHICH IS WHY IT MATTERS. Stalwart turns an
-- expression error into no result, looks up a route named "default", finds
-- none, and delivers by MX — so mail keeps leaving exactly as it did before the
-- lever existed, and the only trace is an `Eval(Error)` event.
--
-- ⚠ STILL NO TABLE GRANTS. USAGE lets the role name objects in `core`; it
-- confers no rights on any of them. The function remains the whole surface.
--
-- CONNECT is explicit for the same reason as authd's in 0001: today it holds
-- only because PUBLIC keeps the default CONNECT on the database, and revoking
-- that later should not quietly switch the lever off.

GRANT CONNECT ON DATABASE i10 TO stalwart;
--> statement-breakpoint
GRANT USAGE ON SCHEMA core TO stalwart;
