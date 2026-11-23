-- The login roles, and nothing else.
--
-- ⚠ ONLY THE ROLES, BECAUSE THE MIGRATIONS OWN EVERYTHING ELSE. An earlier
-- version of this file also created the `core`, `authd` and `pdns` schemas and
-- set default privileges on them - and that broke migrations outright:
-- migration 0000 opens with a bare `CREATE SCHEMA "authd"`, which fails on a
-- schema that already exists, and the migrator stops on the first file. The
-- grants were redundant too; 0001, 0002 and 0003 already issue exactly the same
-- `ALTER DEFAULT PRIVILEGES` for `i10_api`, and 0040 does it for `pdns`.
--
-- In production these roles come from CNPG's `managed.roles` - see
-- infra/k8s/i10/platform-db/cluster.yaml. This file is that, for a laptop.
--
-- ⚠ `i10_api` IS NOT THE OWNER, AND THAT IS THE WHOLE POINT. Row level security
-- does not apply to a table's owner: every tenant policy in the `core` schema
-- is a silent no-op for the role that created the tables. A local database
-- where the app connects as the owner is one where the tenant boundary does not
-- exist - so an RLS bug could never be caught before production.
-- `apps/api/src/db/client.ts` refuses to start against an owning, superuser or
-- BYPASSRLS role, which turns that from a quiet leak into a startup failure.
--
-- ⚠ AND THE PASSWORDS ARE WORTHLESS ON PURPOSE. This database listens on a
-- laptop's loopback and holds fixtures. A real secret here would be a real
-- secret committed to the repository.
-- ⚠ ALL FIVE, BECAUSE THE MIGRATIONS GRANT TO ALL FIVE. `stalwart`, `authd`
-- and `mailfront` have no local process to log in as - the mail server, the
-- LDAP bridge and the mail front are not part of `bun dev` - but migrations
-- 0001 and onwards issue `GRANT … TO authd` and `… TO stalwart`, and
-- `*_mailfront_role_grants` grants to `mailfront`. A GRANT to a role that does
-- not exist is an error that stops the migrator on that file. They exist here
-- so the schema can be built, not because anything connects as them.
--
-- This file runs only when the volume is first created. A database made before
-- a role was added here needs it added by hand (README.md, "Getting started").
CREATE ROLE i10_api LOGIN PASSWORD 'i10_api';
CREATE ROLE authd LOGIN PASSWORD 'authd';
CREATE ROLE stalwart LOGIN PASSWORD 'stalwart';
CREATE ROLE pdns LOGIN PASSWORD 'pdns';
CREATE ROLE mailfront LOGIN PASSWORD 'mailfront';
