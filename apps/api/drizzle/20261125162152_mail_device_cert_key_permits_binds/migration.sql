-- ⚠ A LOCK TIMEOUT FIRST. The rename, the index drop/rebuild and the new CHECK
-- take ACCESS EXCLUSIVE on `authd.mail_devices`, and the three foreign keys take
-- SHARE ROW EXCLUSIVE on `authd.mail_devices` and `authd.accounts`, which is read
-- and written on every sign-in. Each waits behind any open writer and blocks
-- every later one while it waits; five seconds and the batch fails (the Job
-- retries) instead of stalling sign-ins (PostgreSQL docs, 13.3.1 "Table-Level
-- Locks").
--
-- Nothing here scans anything that grows yet: the two new tables are empty, and
-- `authd.mail_devices` holds at most a few operator-made rows (no enrollment
-- until PR 4), so the CHECK's validation and the index rebuild read a page or
-- two. The column rename is catalog only. Postgres would carry the index
-- predicate across the rename by itself; drizzle-kit compares the predicate's
-- text, so it rebuilds the index under its new name, which costs the same page
-- or two.
--
-- Safe across a rolling deploy: no production code in the API, authd or mailfront
-- reads or writes `cert_sha256` (`apps/api/src/mail-devices/store.ts` never names
-- it in `mint`'s `.values()` or `.returning()` lists), and every existing row has
-- NULL in it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "authd"."mail_device_cert_binds" (
	"device_id" uuid,
	"addr" cidr,
	"key_sha256" bytea NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_device_cert_binds_pkey" PRIMARY KEY("device_id","addr"),
	CONSTRAINT "mail_device_cert_binds_addr_check" CHECK ((family("addr") = 4 and masklen("addr") = 32)
          or (family("addr") = 6 and masklen("addr") = 64)),
	CONSTRAINT "mail_device_cert_binds_key_length" CHECK (octet_length("key_sha256") = 32)
);
--> statement-breakpoint
CREATE TABLE "authd"."mail_device_cert_permits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"clerk_user_id" text NOT NULL,
	"device_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"serial" text NOT NULL,
	"nonce_sha256" bytea,
	"challenge_hash" bytea,
	"key_sha256" bytea,
	"transaction_id" text,
	"issued_cert_sha256" bytea,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_device_cert_permits_kind_check" CHECK ("kind" in ('acme', 'scep')),
	CONSTRAINT "mail_device_cert_permits_status_check" CHECK ("status" in ('open', 'challenged', 'authorized', 'notified', 'expired')),
	CONSTRAINT "mail_device_cert_permits_status_kind" CHECK ("kind" = 'scep' or "status" in ('open', 'authorized', 'expired')),
	CONSTRAINT "mail_device_cert_permits_serial_check" CHECK ("serial" <> ''),
	CONSTRAINT "mail_device_cert_permits_device_kind" CHECK (("kind" = 'acme') = ("device_id" is not null)),
	CONSTRAINT "mail_device_cert_permits_nonce_kind" CHECK (("kind" = 'acme') = ("nonce_sha256" is not null)),
	CONSTRAINT "mail_device_cert_permits_challenge_kind" CHECK (("kind" = 'scep') = ("challenge_hash" is not null)),
	CONSTRAINT "mail_device_cert_permits_key_state" CHECK (case "status" when 'open' then "key_sha256" is null
                           when 'expired' then true
                           else "key_sha256" is not null end),
	CONSTRAINT "mail_device_cert_permits_transaction_state" CHECK (case when "kind" = 'acme' or "status" = 'open' then "transaction_id" is null
               when "status" = 'expired' then true
               else "transaction_id" is not null end),
	CONSTRAINT "mail_device_cert_permits_issued_state" CHECK (case "status" when 'notified' then "issued_cert_sha256" is not null
                           when 'expired' then "kind" = 'scep' or "issued_cert_sha256" is null
                           else "issued_cert_sha256" is null end),
	CONSTRAINT "mail_device_cert_permits_hash_lengths" CHECK (("nonce_sha256" is null or octet_length("nonce_sha256") = 32)
          and ("challenge_hash" is null or octet_length("challenge_hash") = 32)
          and ("key_sha256" is null or octet_length("key_sha256") = 32)
          and ("issued_cert_sha256" is null or octet_length("issued_cert_sha256") = 32)),
	CONSTRAINT "mail_device_cert_permits_transaction_length" CHECK ("transaction_id" is null or octet_length("transaction_id") between 1 and 255),
	CONSTRAINT "mail_device_cert_permits_expiry_check" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
ALTER TABLE "authd"."mail_devices" RENAME COLUMN "cert_sha256" TO "cert_key_sha256";--> statement-breakpoint
ALTER INDEX "authd"."mail_devices_cert_sha256_unique" RENAME TO "mail_devices_cert_key_sha256_unique";--> statement-breakpoint
DROP INDEX "authd"."mail_devices_cert_key_sha256_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "mail_devices_cert_key_sha256_unique" ON "authd"."mail_devices" ("cert_key_sha256") WHERE "cert_key_sha256" is not null;--> statement-breakpoint
CREATE INDEX "mail_device_cert_binds_bound_at_idx" ON "authd"."mail_device_cert_binds" ("bound_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_device_cert_permits_open_acme_serial" ON "authd"."mail_device_cert_permits" ("serial") WHERE "kind" = 'acme' and "status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "mail_device_cert_permits_nonce_unique" ON "authd"."mail_device_cert_permits" ("nonce_sha256") WHERE "nonce_sha256" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_device_cert_permits_challenge_unique" ON "authd"."mail_device_cert_permits" ("challenge_hash") WHERE "challenge_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_device_cert_permits_key_unique" ON "authd"."mail_device_cert_permits" ("key_sha256") WHERE "key_sha256" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_device_cert_permits_transaction_unique" ON "authd"."mail_device_cert_permits" ("transaction_id") WHERE "transaction_id" is not null and "status" in ('challenged', 'authorized');--> statement-breakpoint
CREATE INDEX "mail_device_cert_permits_account_idx" ON "authd"."mail_device_cert_permits" ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "mail_device_cert_permits_device_idx" ON "authd"."mail_device_cert_permits" ("device_id") WHERE "device_id" is not null;--> statement-breakpoint
CREATE INDEX "mail_device_cert_permits_expires_idx" ON "authd"."mail_device_cert_permits" ("expires_at");--> statement-breakpoint
ALTER TABLE "authd"."mail_device_cert_binds" ADD CONSTRAINT "mail_device_cert_binds_device_fk" FOREIGN KEY ("device_id") REFERENCES "authd"."mail_devices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "authd"."mail_device_cert_permits" ADD CONSTRAINT "mail_device_cert_permits_account_fk" FOREIGN KEY ("clerk_user_id") REFERENCES "authd"."accounts"("clerk_user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "authd"."mail_device_cert_permits" ADD CONSTRAINT "mail_device_cert_permits_device_fk" FOREIGN KEY ("device_id") REFERENCES "authd"."mail_devices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "authd"."mail_devices" ADD CONSTRAINT "mail_devices_cert_key_sha256_length" CHECK ("cert_key_sha256" is null or octet_length("cert_key_sha256") = 32);