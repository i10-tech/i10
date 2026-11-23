-- Scale seed for the mail front's sweep benchmark (mail-device-binding.md, section 9).
-- A THROWAWAY LOCAL DATABASE ONLY, migrated from apps/api/drizzle. Never production.
\set ON_ERROR_STOP on
\timing on
BEGIN;
INSERT INTO core.tenants (slug, name, owner_clerk_user_id)
SELECT 'bench-' || g, 'Bench ' || g, 'bench_owner_' || g FROM generate_series(1, 20000) g;

CREATE TEMP TABLE bt AS
SELECT id, row_number() OVER (ORDER BY slug) AS n FROM core.tenants WHERE slug LIKE 'bench-%';

INSERT INTO core.domains (tenant_id, name, hosts_mailboxes, status, identity_registered_at)
SELECT id, 't' || n || '.bench.test', true, 'verified', now() FROM bt;

-- 500,000 accounts, 25 per tenant, on the tenant's domain.
INSERT INTO authd.accounts (clerk_user_id, email, active, tenant_id, clerk_updated_at)
SELECT 'bench_' || g, 'u' || g || '@t' || (1 + g % 20000) || '.bench.test', true, bt.id, now()
  FROM generate_series(1, 500000) g JOIN bt ON bt.n = 1 + g % 20000;

-- 500 tenants run an SSO connection that requires SSO on their domain, with five
-- exempt people each, and 10 managed accounts each.
INSERT INTO identity.connections (tenant_id, name, protocol, status)
SELECT id, 'Bench SSO', 'saml', 'active' FROM bt WHERE n <= 500;

INSERT INTO authd.required_domains (domain, tenant_id, connection_id)
SELECT 't' || bt.n || '.bench.test', bt.id, c.id
  FROM bt JOIN identity.connections c ON c.tenant_id = bt.id WHERE bt.n <= 500;

INSERT INTO authd.required_exempt (connection_id, tenant_id, clerk_user_id, source)
SELECT c.id, a.tenant_id, a.clerk_user_id, 'bypass'
  FROM identity.connections c
  JOIN LATERAL (SELECT clerk_user_id, tenant_id FROM authd.accounts
                 WHERE tenant_id = c.tenant_id ORDER BY clerk_user_id LIMIT 5) a ON true;

INSERT INTO identity.managed_accounts (clerk_user_id, tenant_id, reason)
SELECT a.clerk_user_id, a.tenant_id, 'scim'
  FROM identity.connections c
  JOIN LATERAL (SELECT clerk_user_id, tenant_id FROM authd.accounts
                 WHERE tenant_id = c.tenant_id ORDER BY clerk_user_id DESC LIMIT 10) a ON true;

INSERT INTO authd.managed_accounts (clerk_user_id, connection_id)
SELECT m.clerk_user_id, c.id FROM identity.managed_accounts m
  JOIN identity.connections c ON c.tenant_id = m.tenant_id
 WHERE m.clerk_user_id LIKE 'bench_%';

-- A few of every refusal, so the gate columns are not all false.
UPDATE authd.accounts SET suspended_at = now() WHERE clerk_user_id IN (SELECT 'bench_' || g FROM generate_series(7, 500000, 997) g);
UPDATE authd.accounts SET payment_hold_at = now() WHERE clerk_user_id IN (SELECT 'bench_' || g FROM generate_series(11, 500000, 1499) g);
COMMIT;
ANALYZE;
SELECT (SELECT count(*) FROM authd.accounts) accounts, (SELECT count(*) FROM core.domains) domains,
       (SELECT count(*) FROM authd.required_domains) required, (SELECT count(*) FROM authd.required_exempt) exempt,
       (SELECT count(*) FROM authd.managed_accounts) managed;
