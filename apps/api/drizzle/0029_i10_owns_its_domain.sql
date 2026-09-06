-- i10.tech becomes a domain the `i10` tenant owns, and its mailboxes are
-- attributed to it.
--
-- ⚠ THIS REVERSES A STATED DECISION, DELIBERATELY. 0016 said i10.tech "owns no
-- row" and its mailboxes "belong to no customer", and left them unattributed on
-- purpose — inventing an owner is worse than admitting there is none. That was
-- right while nothing measured them. It stopped being right when storage,
-- seats and domains became metered: an unattributed mailbox is invisible to
-- every level, so the one deployment we can actually observe is the one the
-- meters cannot see. i10 is a tenant like any other; this makes it one.
--
-- ⚠ AND WITHOUT IT THE STORAGE SAMPLER CANNOT BE TESTED AT ALL. Its first
-- production run reported `tenants: 0, mailboxes: 0` — not a failure, an empty
-- question, which is indistinguishable from a sampler that silently does
-- nothing. `core.tenant_mailboxes()` excludes NULL owners, correctly, so with
-- no domain row there is nothing to sample and no way to tell working from
-- broken.

-- ⚠ BY SLUG, NEVER BY A LITERAL UUID. The tenant's id is generated per
-- deployment; hardcoding production's would silently attribute nothing
-- anywhere else, and a migration that quietly does nothing is the failure this
-- whole file exists to correct.
--
-- ⚠ AND IT INSERTS NOTHING WHERE THAT TENANT DOES NOT EXIST. A fresh database
-- has no `i10` tenant, so the SELECT returns no rows and this is a no-op —
-- which is the honest outcome, not a missing owner to invent.
INSERT INTO core.domains (tenant_id, name, sends, hosts_mailboxes, verified_at)
SELECT t.id, 'i10.tech', false, true, now()
  FROM core.tenants t
 WHERE t.slug = 'i10'
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

-- ⚠ `sends` IS FALSE, AND THAT IS NOT AN OVERSIGHT. `domains.sending` counts
-- rows where `sends`, and the feature means "an SES identity with DKIM and a
-- MAIL FROM subdomain" — this row has no `dkim_selector`, no
-- `dkim_public_key` and no `ses_tenant_name`, because it was never provisioned
-- through the domains API. i10's own outbound goes through `MAIL_DOMAINS`,
-- which is a separate list the projection unions in; marking it here would
-- consume a sending-domain allowance for an identity that does not exist and
-- would make the level disagree with SES.
--
-- ⚠ `verified_at` IS SET WITHOUT A DNS CHECK, WHICH IS THE ONE CLAIM HERE THAT
-- IS NOT MECHANICAL. `core.mailbox_domains()` requires it, and i10 controls
-- i10.tech's DNS — the MX, SPF and DKIM for it are ours and already published.
-- For any customer domain this would be a lie and the verification flow is the
-- only thing allowed to write this column.

-- Attribute the mailboxes that already exist.
--
-- ⚠ THE SAME STATEMENT 0016 RAN, RE-RUN NOW THAT IT HAS SOMETHING TO MATCH.
-- It was a documented no-op there, and copying it rather than inventing a
-- narrower one keeps a single definition of what attribution means: the domain
-- of the address, verified, hosting mailboxes. A mailbox on acme.com belongs
-- to whoever proved they control acme.com — which is also the only derivation
-- that cannot disagree with how Stalwart routes.
UPDATE authd.accounts a
   SET tenant_id = d.tenant_id
  FROM core.domains d
 WHERE a.tenant_id IS NULL
   AND d.hosts_mailboxes
   AND d.verified_at IS NOT NULL
   AND lower(split_part(a.email, '@', 2)) = lower(d.name);
