-- Normalise any mixed-case values before adding lowercase CHECK constraints.
-- Every unique constraint that could collide under lower() is checked first
-- and raises with the table name and colliding key count rather than silently
-- dropping or merging rows.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
DO $$
DECLARE
  n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM "core"."domains" WHERE "name" <> lower("name")) THEN
    SELECT count(*) INTO n FROM (
      SELECT "tenant_id", lower("name")
      FROM "core"."domains"
      GROUP BY "tenant_id", lower("name")
      HAVING count(*) > 1
    ) c;
    IF n > 0 THEN
      RAISE EXCEPTION 'cannot lowercase core.domains.name: % duplicate (tenant_id, lower(name)) key(s) would collide with domains_tenant_name_unique', n;
    END IF;

    SELECT count(*) INTO n FROM (
      SELECT lower("name")
      FROM "core"."domains"
      WHERE "status" = 'verified'
      GROUP BY lower("name")
      HAVING count(*) > 1
    ) c;
    IF n > 0 THEN
      RAISE EXCEPTION 'cannot lowercase core.domains.name: % duplicate verified lower(name) key(s) would collide with domains_verified_name_unique', n;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM "core"."suppressions" WHERE "address" <> lower("address")) THEN
    SELECT count(*) INTO n FROM (
      SELECT "tenant_id", lower("address")
      FROM "core"."suppressions"
      GROUP BY "tenant_id", lower("address")
      HAVING count(*) > 1
    ) c;
    IF n > 0 THEN
      RAISE EXCEPTION 'cannot lowercase core.suppressions.address: % duplicate (tenant_id, lower(address)) key(s) would collide with suppressions_pkey', n;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM "authd"."aliases" WHERE "address" <> lower("address")) THEN
    SELECT count(*) INTO n FROM (
      SELECT lower("address")
      FROM "authd"."aliases"
      GROUP BY lower("address")
      HAVING count(*) > 1
    ) c;
    IF n > 0 THEN
      RAISE EXCEPTION 'cannot lowercase authd.aliases.address: % duplicate lower(address) key(s) would collide with aliases_pkey', n;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM "authd"."accounts" WHERE "email" <> lower("email")) THEN
    SELECT count(*) INTO n FROM (
      SELECT lower("email")
      FROM "authd"."accounts"
      GROUP BY lower("email")
      HAVING count(*) > 1
    ) c;
    IF n > 0 THEN
      RAISE EXCEPTION 'cannot lowercase authd.accounts.email: % duplicate lower(email) key(s) would collide with accounts_email_unique', n;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM "authd"."groups" WHERE "email" IS NOT NULL AND "email" <> lower("email")) THEN
    SELECT count(*) INTO n FROM (
      SELECT lower("email")
      FROM "authd"."groups"
      WHERE "email" IS NOT NULL
      GROUP BY lower("email")
      HAVING count(*) > 1
    ) c;
    IF n > 0 THEN
      RAISE EXCEPTION 'cannot lowercase authd.groups.email: % duplicate lower(email) key(s) would collide with groups_email_unique', n;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM "core"."join_domains" WHERE "name" <> lower("name")) THEN
    SELECT count(*) INTO n FROM (
      SELECT "tenant_id", lower("name")
      FROM "core"."join_domains"
      GROUP BY "tenant_id", lower("name")
      HAVING count(*) > 1
    ) c;
    IF n > 0 THEN
      RAISE EXCEPTION 'cannot lowercase core.join_domains.name: % duplicate (tenant_id, lower(name)) key(s) would collide with join_domains_tenant_name_unique', n;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM "authd"."required_domains" WHERE "domain" <> lower("domain")) THEN
    SELECT count(*) INTO n FROM (
      SELECT lower("domain")
      FROM "authd"."required_domains"
      GROUP BY lower("domain")
      HAVING count(*) > 1
    ) c;
    IF n > 0 THEN
      RAISE EXCEPTION 'cannot lowercase authd.required_domains.domain: % duplicate lower(domain) key(s) would collide with required_domains_pkey', n;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM "core"."join_exclusions" WHERE "email" <> lower("email")) THEN
    SELECT count(*) INTO n FROM (
      SELECT "tenant_id", lower("email")
      FROM "core"."join_exclusions"
      GROUP BY "tenant_id", lower("email")
      HAVING count(*) > 1
    ) c;
    IF n > 0 THEN
      RAISE EXCEPTION 'cannot lowercase core.join_exclusions.email: % duplicate (tenant_id, lower(email)) key(s) would collide with join_exclusions_tenant_email_unique', n;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM "core"."delegations" WHERE "name" <> lower("name")) THEN
    SELECT count(*) INTO n FROM (
      SELECT lower("name")
      FROM "core"."delegations"
      GROUP BY lower("name")
      HAVING count(*) > 1
    ) c;
    IF n > 0 THEN
      RAISE EXCEPTION 'cannot lowercase core.delegations.name: % duplicate lower(name) key(s) would collide with delegations_name_unique', n;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM "core"."mailbox_usage" WHERE "address" <> lower("address")) THEN
    SELECT count(*) INTO n FROM (
      SELECT "tenant_id", lower("address")
      FROM "core"."mailbox_usage"
      GROUP BY "tenant_id", lower("address")
      HAVING count(*) > 1
    ) c;
    IF n > 0 THEN
      RAISE EXCEPTION 'cannot lowercase core.mailbox_usage.address: % duplicate (tenant_id, lower(address)) key(s) would collide with mailbox_usage_pkey', n;
    END IF;
  END IF;
END $$;--> statement-breakpoint
UPDATE "core"."domains" SET "name" = lower("name") WHERE "name" <> lower("name");--> statement-breakpoint
UPDATE "core"."suppressions" SET "address" = lower("address") WHERE "address" <> lower("address");--> statement-breakpoint
UPDATE "authd"."aliases" SET "address" = lower("address") WHERE "address" <> lower("address");--> statement-breakpoint
UPDATE "authd"."accounts" SET "email" = lower("email") WHERE "email" <> lower("email");--> statement-breakpoint
UPDATE "authd"."groups" SET "email" = lower("email") WHERE "email" IS NOT NULL AND "email" <> lower("email");--> statement-breakpoint
UPDATE "core"."join_domains" SET "name" = lower("name") WHERE "name" <> lower("name");--> statement-breakpoint
UPDATE "authd"."required_domains" SET "domain" = lower("domain") WHERE "domain" <> lower("domain");--> statement-breakpoint
UPDATE "core"."join_exclusions" SET "email" = lower("email") WHERE "email" <> lower("email");--> statement-breakpoint
UPDATE "core"."domain_transfers" SET "recipient_email" = lower("recipient_email") WHERE "recipient_email" <> lower("recipient_email");--> statement-breakpoint
UPDATE "core"."member_invitations" SET "email" = lower("email") WHERE "email" <> lower("email");--> statement-breakpoint
UPDATE "core"."delegations" SET "name" = lower("name") WHERE "name" <> lower("name");--> statement-breakpoint
UPDATE "core"."mailbox_usage" SET "address" = lower("address") WHERE "address" <> lower("address");--> statement-breakpoint
UPDATE "core"."mailbox_jobs" SET "mailbox_address" = lower("mailbox_address") WHERE "mailbox_address" <> lower("mailbox_address");--> statement-breakpoint
UPDATE "core"."mailbox_auth_failures" SET "account" = lower("account") WHERE "account" <> lower("account");--> statement-breakpoint
UPDATE "identity"."directory_users" SET "email" = lower("email") WHERE "email" IS NOT NULL AND "email" <> lower("email");--> statement-breakpoint
UPDATE "identity"."identities" SET "email" = lower("email") WHERE "email" IS NOT NULL AND "email" <> lower("email");
