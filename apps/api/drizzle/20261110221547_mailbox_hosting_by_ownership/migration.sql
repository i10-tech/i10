-- Hosting mailboxes on a domain needs OWNERSHIP of the name, not SES's opinion
-- of it (#406).
--
-- ⚠ `core.mailbox_domains()` USED TO ASK `verified_at IS NOT NULL`, AND THAT IS
-- SES'S DKIM VERDICT. It answers "can mail LEAVE from this name", which is a
-- different product from "may this name RECEIVE and sign people in". A domain
-- whose sending identity never finished (`not_started`, or SES slow, or SES
-- failed) could not host a mailbox, for a reason that has nothing to do with
-- mail hosting. Google Workspace and Microsoft 365 ask for ownership and
-- nothing else; so do we now. Sending is checked where it is used, and the
-- console shows it beside the hosting switch.
--
-- ⚠ "HOLDS THE NAME NOW" IS THE LATEST ACTIVE PROOF, AND THERE ARE TWO KINDS OF
-- PROOF IN THIS DATABASE. Neither is SES.
--
--   1. A sending-domain proof (core.domains): DKIM published at our selector, or
--      the delegation to this claim's nameservers. Ownership is proved BEFORE SES
--      is told (`verify` in domains/store.ts), so a row that has ever been
--      proved carries `identity_registered_at` (set once, after the proof) or
--      `verified_at` (set once, when SES first said verified; also how 0029
--      seeded i10.tech, whose DNS is ours). It still holds while it is
--      `verified` or the proof has not lapsed. The re-check stands a row down
--      by setting `status = 'failed'` with `proof_missing_since` set
--      (`displace_domain`, 0044), and another workspace proving the name sets
--      `displaced_at` (0058). Either ends it.
--
--   2. A TXT proof (core.join_domains with source 'txt'): `_i10-access.<name>`,
--      made for SSO and team access. Active is `verified_at` set with `lapsed_at`
--      and `displaced_at` null, the same predicate console/join.ts uses. This is
--      the "SSO proof alone is enough" case: a workspace that proved the name
--      for SSO may host mail on it without ever finishing sending set-up.
--      A source 'domains' entry is NOT a proof of its own, it mirrors the
--      sending-domain row above, so counting it again would let it outbid the
--      row it came from.
--
-- ⚠ ONE WINNER PER NAME, BY PROOF TIME, BECAUSE NAMES ARE NOT UNIQUE ACROSS
-- WORKSPACES (0039) AND "LATEST PROOF WINS" IS THE RULE ON /domains AND ON TEAM
-- ACCESS. Only the verified rows are displaced by `clearTheWay`, and a TXT proof
-- displaces only other TXT proofs, so two workspaces can each hold an active
-- proof of one name. Returning both would make the projection, the MTA hook and
-- the mailbox routes disagree about who owns an address. The proof time is the
-- time that proof was made: `identity_registered_at` (else `verified_at`, else
-- the row's creation, for a hand-made row) for kind 1, `join_domains.verified_at`
-- for kind 2. Ties fall to the lower tenant id, which only has to be stable.
--
-- ⚠ A PROOF COVERS EXACTLY ITS NAME. `join_domains` entries also match
-- subdomains for team access, but hosting `mail.example.com` on the strength of
-- a proof of `example.com` is a decision about whose DNS controls it, and a
-- delegated subzone is exactly where that is false. Exact is the fail-closed
-- reading; a workspace proves the name it hosts.
--
-- ⚠ KNOWN LIMIT: A RE-VERIFY OF THE SAME ROW DOES NOT MOVE ITS PROOF TIME
-- (`identity_registered_at` is the FIRST registration, deliberately). If
-- workspace A re-proves a name after workspace B's TXT proof outranks it, B
-- keeps hosting until B's proof lapses or A's row is displaced-and-recreated.
-- Fixing it means a `proved_at` column written by every verify; not done here.
--
-- ⚠ THE RECHECK (domains_due_recheck) STILL ONLY WALKS `status = 'verified'`
-- ROWS. A hosted domain that SES never verified is not re-checked for proof, so
-- its hosting ends only on displacement or on a lapse the TXT path records. That
-- is the same reach the sending-domain proof had before this change and is a
-- follow-up, not a regression.

-- Who holds each name now (or the one name asked about).
CREATE FUNCTION "core"."name_holders"(p_name text DEFAULT NULL)
RETURNS TABLE (
  name text,
  tenant_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH proofs AS (
    SELECT lower(d.name) AS name,
           d.tenant_id,
           coalesce(d.identity_registered_at, d.verified_at, d.created_at) AS proved_at
      FROM core.domains d
     WHERE (p_name IS NULL OR lower(d.name) = lower(p_name))
       AND d.displaced_at IS NULL
       AND (d.status = 'verified'
            OR d.identity_registered_at IS NOT NULL
            OR d.verified_at IS NOT NULL)
       AND NOT (d.status = 'failed' AND d.proof_missing_since IS NOT NULL)
    UNION ALL
    SELECT lower(j.name), j.tenant_id, j.verified_at
      FROM core.join_domains j
     WHERE (p_name IS NULL OR lower(j.name) = lower(p_name))
       AND j.source = 'txt'
       AND j.verified_at IS NOT NULL
       AND j.lapsed_at IS NULL
       AND j.displaced_at IS NULL
  )
  SELECT DISTINCT ON (proofs.name) proofs.name, proofs.tenant_id
    FROM proofs
   ORDER BY proofs.name, proofs.proved_at DESC, proofs.tenant_id
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."name_holders"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."name_holders"(text) TO i10_api;
--> statement-breakpoint

-- The hosted domains, with what the mail server needs to know about each.
--
-- ⚠ ONE PREDICATE FOR "MAY HOST", SHARED BY EVERY CALLER: the row is switched on
-- (`hosts_mailboxes`), is not displaced (a displaced row must never host, even
-- when a TXT proof of its tenant would otherwise carry it), and its workspace
-- holds the name by the rule above. `mailbox_domains()` below and the authd
-- gate read this, so the answer to "may this name receive" cannot differ
-- between the places that ask it.
--
-- ⚠ SECURITY DEFINER AND CROSS-TENANT FOR THE REASON `mailbox_domains()` IS: the
-- reconcile cron holds no tenant context and `core.domains` is under row level
-- security. It returns a name, its owner and a catch-all address, all of which
-- the callers are already entitled to act on.
CREATE FUNCTION "core"."mailbox_domain_settings"(p_name text DEFAULT NULL)
RETURNS TABLE (
  name text,
  tenant_id uuid,
  catch_all_address text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.name, d.tenant_id, d.catch_all_address
    FROM core.domains d
    JOIN core.name_holders(p_name) h
      ON h.name = lower(d.name) AND h.tenant_id = d.tenant_id
   WHERE d.hosts_mailboxes
     AND d.displaced_at IS NULL
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."mailbox_domain_settings"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."mailbox_domain_settings"(text) TO i10_api;
--> statement-breakpoint

-- ⚠ SAME NAME, SAME COLUMNS, NEW PREDICATE. `CREATE OR REPLACE` keeps the grant
-- from 0016 and every caller (projection, mailbox routes, MTA hook, team
-- inboxes) with it. A name that is in this list is a LOCAL RECIPIENT: Stalwart
-- accepts and stores mail for it, so the predicate above is a security boundary.
CREATE OR REPLACE FUNCTION "core"."mailbox_domains"()
RETURNS TABLE (
  name text,
  tenant_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT s.name, s.tenant_id FROM core.mailbox_domain_settings() s
$$;
--> statement-breakpoint

-- Whether this workspace holds this name now, for the route that switches
-- hosting on: it must say "you do not own this" rather than fail later.
CREATE FUNCTION "core"."holds_name"(p_tenant uuid, p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.name_holders(p_name) h WHERE h.tenant_id = p_tenant
  )
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."holds_name"(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."holds_name"(uuid, text) TO i10_api;
--> statement-breakpoint

-- Whether a mailbox on this domain must be refused a login, for authd.
--
-- ⚠ THE DOMAIN-LEVEL GATE, AND IT REPLACES STAMPING EVERY MAILBOX. Switching
-- hosting off, losing the name to another workspace, or a lapsed proof all make
-- the domain leave `mailbox_domains()`. authd reads this in the SAME query as
-- the account it is about to bind (services/authd internal/projection), ahead of
-- the credential cache, so every one of those closes the login on both pods at
-- the next bind with no per-mailbox write - and switching hosting back on
-- reopens them, while a mailbox an admin suspended by hand stays suspended
-- because `suspended_at` was never touched.
--
-- ⚠ REFUSED ONLY WHEN THE NAME HAS A `core.domains` ROW AT ALL. i10's own
-- domains predate tenancy and `MAIL_DOMAINS` serves them with no row (0016,
-- 0029); a deployment without one must not lock its own people out, so a name
-- nobody ever registered is not this function's to refuse.
--
-- ⚠ AND IT IS TENANT-SCOPED WHEN THE ACCOUNT HAS A TENANT. A mailbox whose
-- `tenant_id` is a workspace that no longer holds the name must not sign in to
-- the domain's new owner's mail; a null `tenant_id` (a mailbox from before the
-- column was filled in) is judged by the name alone.
--
-- ⚠ SECURITY DEFINER, WHICH IS WHAT LETS THE `authd` ROLE ASK WITHOUT HOLDING
-- ANY GRANT ON `core.domains`: it can run this one function and learn one
-- boolean. It is the only thing in `core` that role may execute.
CREATE FUNCTION "core"."mailbox_domain_refused"(p_tenant uuid, p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM core.domains d WHERE lower(d.name) = lower(p_name))
     AND NOT EXISTS (
       SELECT 1
         FROM core.mailbox_domain_settings(p_name) m
        WHERE p_tenant IS NULL OR m.tenant_id = p_tenant
     )
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."mailbox_domain_refused"(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "core" TO authd;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."mailbox_domain_refused"(uuid, text) TO authd;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."mailbox_domain_refused"(uuid, text) TO i10_api;
