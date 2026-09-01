-- Least-privilege access for the `authd` role.
--
-- authd reads the projection to answer Stalwart's LDAP searches and never
-- writes to it. It also parses attacker-influenced input — login strings and
-- passwords from any IMAP client, recipient addresses arriving from any sending
-- MTA — so the blast radius of a bug in it should stop at SELECT on four tables.
--
-- ⚠ THE ROLE IS CREATED BY CNPG, NOT HERE. `managed.roles` in
-- infra/k8s/i10/platform-db/cluster.yaml owns its existence and password;
-- this migration only grants it rights. Running this against a cluster where
-- CNPG has not yet reconciled the role fails on the first GRANT, which is the
-- correct order of operations rather than a problem to work around.

GRANT CONNECT ON DATABASE i10 TO authd;
--> statement-breakpoint
GRANT USAGE ON SCHEMA authd TO authd;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA authd TO authd;
--> statement-breakpoint

-- Tables added by later migrations need the grant too. Without this, a new
-- table is invisible to authd until someone remembers to re-grant — and the
-- symptom is a permission error on a bind, in production, at 3am.
ALTER DEFAULT PRIVILEGES IN SCHEMA authd GRANT SELECT ON TABLES TO authd;
