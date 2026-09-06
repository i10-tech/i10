-- PowerDNS's own schema, inside the `i10` database.
--
-- ⚠ A SCHEMA HERE, NOT A SEPARATE DATABASE LIKE STALWART'S, AND THE REASON IS
-- ATOMICITY. Our API writes the zone: creating a domain and creating the
-- records that make its delegation work have to succeed or fail together, and
-- Postgres cannot span two databases in one transaction. A domain row whose
-- zone never landed is a customer whose delegated DNS silently answers nothing
-- — with a dashboard that says the domain was created.
--
-- ⚠ THE TRADE IS THAT A POWERDNS UPGRADE MAY WANT COLUMNS WE DID NOT WRITE.
-- Their schema is stable and versioned and they publish the ALTERs, so this is
-- a migration to write rather than a surprise — unlike Stalwart, which
-- migrates itself on start and is pre-1.0. If that ever stops being true, this
-- moves to its own database and the API grows a second connection.
--
-- Taken from PowerDNS/pdns modules/gpgsqlbackend/schema.pgsql.sql, verbatim
-- except for the schema qualification. ⚠ DO NOT "IMPROVE" IT: the column
-- names, types and the lowercase CHECK constraints are what their backend
-- queries expect, and a helpful rename is a nameserver that starts and serves
-- nothing.
CREATE SCHEMA IF NOT EXISTS "pdns";
--> statement-breakpoint

CREATE TABLE "pdns"."domains" (
  id                    SERIAL PRIMARY KEY,
  name                  VARCHAR(255) NOT NULL,
  master                VARCHAR(128) DEFAULT NULL,
  last_check            INT DEFAULT NULL,
  type                  TEXT NOT NULL,
  notified_serial       BIGINT DEFAULT NULL,
  account               VARCHAR(40) DEFAULT NULL,
  options               TEXT DEFAULT NULL,
  catalog               TEXT DEFAULT NULL,
  CONSTRAINT c_lowercase_name CHECK (((name)::TEXT = LOWER((name)::TEXT)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pdns_name_index" ON "pdns"."domains"(name);--> statement-breakpoint
CREATE INDEX "pdns_catalog_idx" ON "pdns"."domains"(catalog);--> statement-breakpoint

CREATE TABLE "pdns"."records" (
  id                    BIGSERIAL PRIMARY KEY,
  domain_id             INT DEFAULT NULL,
  name                  VARCHAR(255) DEFAULT NULL,
  type                  VARCHAR(10) DEFAULT NULL,
  content               VARCHAR(65535) DEFAULT NULL,
  ttl                   INT DEFAULT NULL,
  prio                  INT DEFAULT NULL,
  disabled              BOOL DEFAULT 'f',
  ordername             VARCHAR(255),
  auth                  BOOL DEFAULT 't',
  CONSTRAINT domain_exists
  FOREIGN KEY(domain_id) REFERENCES "pdns"."domains"(id)
  ON DELETE CASCADE,
  CONSTRAINT c_lowercase_name CHECK (((name)::TEXT = LOWER((name)::TEXT)))
);
--> statement-breakpoint
CREATE INDEX "pdns_rec_name_index" ON "pdns"."records"(name);--> statement-breakpoint
CREATE INDEX "pdns_nametype_index" ON "pdns"."records"(name,type);--> statement-breakpoint
CREATE INDEX "pdns_domain_id" ON "pdns"."records"(domain_id);--> statement-breakpoint
CREATE INDEX "pdns_recordorder" ON "pdns"."records" (domain_id, ordername text_pattern_ops);--> statement-breakpoint

CREATE TABLE "pdns"."supermasters" (
  ip                    INET NOT NULL,
  nameserver            VARCHAR(255) NOT NULL,
  account               VARCHAR(40) NOT NULL,
  PRIMARY KEY(ip, nameserver)
);
--> statement-breakpoint

CREATE TABLE "pdns"."comments" (
  id                    SERIAL PRIMARY KEY,
  domain_id             INT NOT NULL,
  name                  VARCHAR(255) NOT NULL,
  type                  VARCHAR(10) NOT NULL,
  modified_at           INT NOT NULL,
  account               VARCHAR(40) DEFAULT NULL,
  comment               VARCHAR(65535) NOT NULL,
  CONSTRAINT domain_exists
  FOREIGN KEY(domain_id) REFERENCES "pdns"."domains"(id)
  ON DELETE CASCADE,
  CONSTRAINT c_lowercase_name CHECK (((name)::TEXT = LOWER((name)::TEXT)))
);
--> statement-breakpoint
CREATE INDEX "pdns_comments_domain_id_idx" ON "pdns"."comments" (domain_id);--> statement-breakpoint
CREATE INDEX "pdns_comments_name_type_idx" ON "pdns"."comments" (name, type);--> statement-breakpoint
CREATE INDEX "pdns_comments_order_idx" ON "pdns"."comments" (domain_id, modified_at);--> statement-breakpoint

CREATE TABLE "pdns"."domainmetadata" (
  id                    SERIAL PRIMARY KEY,
  domain_id             INT REFERENCES "pdns"."domains"(id) ON DELETE CASCADE,
  kind                  VARCHAR(32),
  content               TEXT
);
--> statement-breakpoint
CREATE INDEX "pdns_domainidmetaindex" ON "pdns"."domainmetadata"(domain_id);--> statement-breakpoint

CREATE TABLE "pdns"."cryptokeys" (
  id                    SERIAL PRIMARY KEY,
  domain_id             INT REFERENCES "pdns"."domains"(id) ON DELETE CASCADE,
  flags                 INT NOT NULL,
  active                BOOL,
  published             BOOL DEFAULT TRUE,
  content               TEXT
);
--> statement-breakpoint
CREATE INDEX "pdns_domainidindex" ON "pdns"."cryptokeys"(domain_id);--> statement-breakpoint

CREATE TABLE "pdns"."tsigkeys" (
  id                    SERIAL PRIMARY KEY,
  name                  VARCHAR(255),
  algorithm             VARCHAR(50),
  secret                VARCHAR(255),
  CONSTRAINT c_lowercase_name CHECK (((name)::TEXT = LOWER((name)::TEXT)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pdns_namealgoindex" ON "pdns"."tsigkeys"(name, algorithm);
--> statement-breakpoint

-- ⚠ THE `pdns` ROLE IS NOT CREATED HERE, AND IT USED TO BE. `CREATE ROLE`
-- requires CREATEROLE, which the migration connects as `i10` and does not have
-- — only `postgres` is a superuser on this cluster. So this migration failed on
-- its first real run and took 0024 through 0028 down with it, because the
-- PreSync hook blocks the whole sync.
--
-- ⚠ AND THE FIX IS NOT TO GRANT `i10` CREATEROLE. Roles are CNPG's job on this
-- cluster and are declared in `platform-db/cluster.yaml` under `managed.roles`,
-- each with its password from Doppler — `stalwart`, `authd`, `autumn` and
-- `i10_api` all arrived that way. A migration inventing a login role beside
-- them would be a second writer for the same thing, and CNPG reconciles: what
-- it does not know about, it does not manage.
--
-- ⚠ SO THE NAMESERVER'S GRANTS ARRIVE WITH THE NAMESERVER, DEFERRED RATHER
-- THAN SKIPPED. PowerDNS is not deployed; it has no Doppler config, no password
-- secret and no manifest. The tables below have one consumer today — the API,
-- which writes zones through `i10_api` — and granting to a role nobody
-- authenticates as would buy nothing. When PowerDNS ships, it brings its
-- managed role, its secret and a migration carrying these five grants:
--
--   GRANT CONNECT ON DATABASE i10 TO pdns;
--   GRANT USAGE ON SCHEMA "pdns" TO pdns;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "pdns" TO pdns;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "pdns" TO pdns;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA "pdns" GRANT ... TO pdns;
--
-- ⚠ AND IT NEEDS MORE THAN SELECT, WHICH IS NOT AN OVERSIGHT. PowerDNS writes
-- `domains.notified_serial` when it sends NOTIFYs, and maintains `ordername`
-- and `auth` on records once DNSSEC is enabled. Granting only SELECT produces
-- a server that starts, answers, and fails at whichever of those it reaches
-- first.
--
-- ⚠ THE ISOLATION ARGUMENT IS UNCHANGED AND IS WHY THE SCHEMA IS SEPARATE AT
-- ALL. `pdns` will have no grant on `core` or `authd`, so a compromised
-- nameserver — the one process here answering unauthenticated queries from the
-- whole internet — cannot read a mailbox, a message or an API key.

GRANT USAGE ON SCHEMA "pdns" TO i10_api;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "pdns" TO i10_api;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "pdns" TO i10_api;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "pdns"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO i10_api;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "pdns"
  GRANT USAGE, SELECT ON SEQUENCES TO i10_api;
