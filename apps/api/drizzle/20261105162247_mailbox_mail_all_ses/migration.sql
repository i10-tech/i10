-- The mailbox route uses the same policy as the API route.
--
-- ⚠ TWO IMPLEMENTATIONS STILL EXIST, BUT ONLY BECAUSE THEY HAVE TWO READERS.
-- `resolveRoute` answers for the API and worker; Stalwart evaluates this SQL
-- mirror for a person's mail after it reaches Stalwart's queue. The case table
-- below is identical to test/domains-route.test.ts, in the same order and with
-- the same values, so a wrong SQL mirror fails a migration instead of silently
-- routing human mail differently.
CREATE OR REPLACE FUNCTION "core"."resolve_route"(
  p_override text,
  p_ses_enabled boolean
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    -- The incident kill switch beats an explicit `ses` override too.
    WHEN p_ses_enabled IS NOT TRUE THEN 'direct'
    -- Support may still pin one domain either way.
    WHEN p_override <> 'auto' THEN p_override
    -- 2026-11-05: every plan, including free, uses SES by default.
    ELSE 'ses'
  END
$$;
--> statement-breakpoint

-- ⚠ THE SAME TABLE AS test/domains-route.test.ts, IN THE SAME ORDER. Keep them that way.
DO $$
BEGIN
  -- The kill switch beats everything, including an explicit override.
  ASSERT core.resolve_route('auto',   false) = 'direct';
  ASSERT core.resolve_route('ses',    false) = 'direct';
  ASSERT core.resolve_route('direct', false) = 'direct';

  -- An override wins when SES is enabled.
  ASSERT core.resolve_route('ses',    true) = 'ses';
  ASSERT core.resolve_route('direct', true) = 'direct';

  -- Otherwise auto uses SES.
  ASSERT core.resolve_route('auto',   true) = 'ses';
END $$;
--> statement-breakpoint

-- ⚠ 2026-11-05: HUMAN MAILBOX MAIL USES SES ON EVERY PLAN, INCLUDING FREE.
-- Nothing leaves our own IP while SES is available. `SES_ENABLED` remains the
-- incident kill switch and `SES_RELAY_ENABLED` remains the independent SMTP
-- relay switch. A domain's `direct` mailbox override remains direct; `ses` and
-- `auto` use SES.
--
-- ⚠ OUR OWN DOMAINS ARE CODE-DEFINED, NOT `core.domains` ROWS. `MAIL_DOMAINS`
-- is projected into `routing_settings.mail_domains`, so i10.tech and any other
-- own mailbox domain reach the relay without inventing a tenant domain row.
--
-- ⚠ `sender_domain` IS THE RETURN PATH, NOT THE `From:` DOMAIN. This query sees
-- every queue message, including transactional messages and forwarded mail.
-- The hosted-mailbox join deliberately keeps `send.<domain>`, `bounce.` VERP
-- envelopes, sending-only domains, and outside return paths on `mx`: SES cannot
-- send for identities it has not verified.
CREATE OR REPLACE FUNCTION "core"."mailbox_route"(p_sender_domain text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT CASE
    WHEN s.ses_enabled IS NOT TRUE OR s.ses_relay_enabled IS NOT TRUE THEN 'mx'
    WHEN lower(p_sender_domain) = ANY(s.mail_domains) THEN 'ses-relay'
    WHEN d.name IS NULL THEN 'mx'
    WHEN core.resolve_route(d.mailbox_route::text, s.ses_enabled) = 'ses' THEN 'ses-relay'
    ELSE 'mx'
  END
    FROM core.routing_settings s
    LEFT JOIN core.domains d
      ON lower(d.name) = lower(p_sender_domain)
     AND d.hosts_mailboxes
   WHERE s.id
$$;
--> statement-breakpoint

-- The replacement above removes its dependency on the plan-based implementation.
DROP FUNCTION "core"."resolve_route"(text, text, text, boolean);
