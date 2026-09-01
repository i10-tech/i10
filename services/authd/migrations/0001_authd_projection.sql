-- The Clerk projection.
--
-- Clerk owns identity. This schema is a read model of it, maintained by
-- webhook, and it exists for one reason: LDAP searches must not cost Clerk API
-- calls. Clerk allows 1000 requests per 10 seconds across all of i10, and IMAP
-- clients are chatty — Apple Mail opens several connections per account and
-- re-authenticates on a timer. Serving filterLogin, filterMailbox and
-- filterMemberOf from here means only the bind itself reaches Clerk: one call
-- per authentication, none per delivery.
--
-- Nothing in here is authoritative. If it disagrees with Clerk, Clerk wins and
-- the projection is repaired. In particular there is NO password material of
-- any kind — no hash, no verifier, no salt. Stalwart runs with
-- bindAuthentication=true and never reads a password attribute.

CREATE SCHEMA IF NOT EXISTS authd;

CREATE TABLE authd.accounts (
    clerk_user_id       text PRIMARY KEY,

    -- Primary mailbox address, stored lowercased. LDAP matches mail with
    -- caseIgnoreIA5Match, so normalising on write keeps lookups on the index
    -- instead of forcing a function scan.
    email               text        NOT NULL UNIQUE,

    display_name        text,
    description         text,

    -- The subscription gate. An inactive account is INVISIBLE: filterMailbox
    -- stops returning it, so Stalwart refuses mail for the address, and binds
    -- fail. This is what SCIM deprovisioning would have bought us, and it takes
    -- effect on the next query rather than on a reconciliation run.
    active              boolean     NOT NULL DEFAULT false,

    -- Served to Stalwart as pwdChangeTime (attrSecretChanged). Stalwart compares
    -- it to decide when cached OAuth tokens are stale, so a password change in
    -- Clerk invalidates every issued token without us calling anything.
    password_updated_at timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE authd.aliases (
    address       text PRIMARY KEY,
    clerk_user_id text NOT NULL REFERENCES authd.accounts (clerk_user_id) ON DELETE CASCADE
);

CREATE INDEX aliases_account_idx ON authd.aliases (clerk_user_id);

CREATE TABLE authd.groups (
    name        text PRIMARY KEY,
    email       text UNIQUE,
    description text
);

CREATE TABLE authd.group_members (
    group_name    text NOT NULL REFERENCES authd.groups (name) ON DELETE CASCADE,
    clerk_user_id text NOT NULL REFERENCES authd.accounts (clerk_user_id) ON DELETE CASCADE,
    PRIMARY KEY (group_name, clerk_user_id)
);

CREATE INDEX group_members_account_idx ON authd.group_members (clerk_user_id);

-- Webhook delivery is at-least-once and unordered. Recording the event id makes
-- replays idempotent, and keeping the Clerk timestamp lets a handler drop an
-- update that arrives after a newer one it would otherwise overwrite.
CREATE TABLE authd.webhook_events (
    event_id     text PRIMARY KEY,
    event_type   text        NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now()
);
