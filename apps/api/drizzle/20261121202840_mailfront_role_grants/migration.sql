-- Least privilege for the `mailfront` role: the mail front's revocation sweep
-- and its sign-in lookup (services/authd/internal/mailfront), and nothing else.
--
-- ⚠ ITS OWN ROLE, NOT `authd`'s, BECAUSE `authd` CAN WRITE. 20261107011933 gave
-- `authd` INSERT and UPDATE on `authd.bind_failure_budget`. The front parses
-- bytes from anyone on the internet before they sign in; on `authd`'s role a bug
-- in it could reset or exhaust anyone's failure budget. This role reads exactly
-- what `projection.accountColumns` and `accountFrom` read
-- (services/authd/internal/projection/postgres.go) and writes nothing.
--
-- ⚠ NO DEFAULT PRIVILEGES, ON PURPOSE. A table added to the gate later is not
-- visible to the front until it is granted here, and the front's database test
-- (TestTheMailFrontRoleReadsTheGateAndWritesNothing, which connects as this
-- role) fails until it is. A wider grant would be silent.
--
-- ⚠ THE ROLE IS CREATED BY CNPG, NOT HERE (`managed.roles` in
-- infra/k8s/i10/platform-db/cluster.yaml), AND IT MUST EXIST BEFORE THIS RUNS.
-- This is deliberately NOT guarded the way 20260917035550 is: the migrator
-- records a folder once and never runs it again, so a guard that skipped these
-- grants because the role was missing would leave it without them for good.
-- Run before the role exists, this fails the PreSync migration hook, loudly,
-- and blocks the deploy until the role is there; re-syncing then applies it.

GRANT CONNECT ON DATABASE i10 TO mailfront;
--> statement-breakpoint
GRANT USAGE ON SCHEMA authd TO mailfront;
--> statement-breakpoint
GRANT SELECT ON authd.accounts, authd.managed_accounts, authd.required_domains, authd.required_exempt TO mailfront;
--> statement-breakpoint
GRANT USAGE ON SCHEMA core TO mailfront;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."mailbox_domain_refused"(uuid, text) TO mailfront;
