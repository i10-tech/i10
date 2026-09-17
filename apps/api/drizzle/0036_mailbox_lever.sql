-- The mailbox lever: which MTA a domain's HUMAN mail leaves through.
--
-- ⚠ THE TRANSACTIONAL LEVER IS A TYPESCRIPT DECISION AND THIS ONE CANNOT BE.
-- `stalwartTransport` picks a route before submitting, because our worker owns
-- that message. Mailbox mail is submitted by a person's mail client straight
-- into Stalwart's queue — no code of ours is in that path — so the only place
-- left to decide is Stalwart itself, and the only way to ask us is a query.
-- `MtaOutboundStrategy.route` is an expression evaluated PER RECIPIENT and it is
-- awaited, so `sql_query` works there. Verified against stalwart v0.16:
-- `crates/smtp/src/outbound/delivery.rs` evaluates it, and
-- `crates/common/src/expr/functions/mod.rs` registers `sql_query` with 3 args.
--
-- ⚠ WHICH MAKES THE TIER A LIVE LOOKUP RATHER THAN A CONFIG PUSH. A plan change
-- takes effect on the next message, not on the next deploy, and nothing has to
-- walk every domain in Stalwart when the catalogue changes.

-- ─────────────────────────────────────────────────────────────────────────────
-- The two settings the rule needs that are not already in a row.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ⚠ THE RULE HAS FOUR INPUTS AND ONLY TWO OF THEM LIVE IN THE DATABASE. The
-- domain's override and the tenant's plan are rows; `SES_ENABLED` and
-- `METERING_FREE_PLAN_ID` are environment variables read by the API and the
-- worker. A function Stalwart calls cannot read our pods' environment, so
-- without this table the mailbox lever would have to hardcode the other two —
-- and the kill switch would move transactional mail while leaving human mail
-- pointed at the thing that is down. "One rule, three readers" would stop being
-- true exactly when it mattered most.
--
-- ⚠ THE ENVIRONMENT STAYS THE AUTHORED SOURCE; THIS IS A PROJECTION OF IT. The
-- API upserts this row at boot from its own env (see src/index.ts), so there is
-- still one place a human edits. The drift window is the gap between a Doppler
-- change and the API rolling — which is the same window the API itself has, so
-- this introduces no staleness that did not already exist.
CREATE TABLE "core"."routing_settings" (
  -- ⚠ A ONE-ROW TABLE, ENFORCED BY THE PRIMARY KEY RATHER THAN BY CONVENTION. A
  -- second row would give the function two answers and `LIMIT 1` would pick one
  -- silently.
  "id" boolean PRIMARY KEY DEFAULT true CHECK ("id"),

  -- Mirrors `SES_ENABLED`. The operator kill switch.
  "ses_enabled" boolean NOT NULL DEFAULT true,

  -- ⚠ A SECOND SWITCH, AND NOT A DUPLICATE OF THE FIRST. The transactional route
  -- uses the SES **API**; mailbox mail can only use SES **SMTP**, because
  -- Stalwart's outbound has no HTTP hook. Those are different credentials that
  -- can exist independently, so one flag cannot govern both.
  --
  -- ⚠ IT DEFAULTS TO FALSE SO THIS MIGRATION CHANGES NOTHING ON THE DAY IT
  -- APPLIES. i10.tech is on `pro` and hosts mailboxes, so a default of true
  -- would silently move our own human mail from our MTA onto an SES relay that
  -- has no credentials yet. Off until somebody creates them and means it.
  "ses_relay_enabled" boolean NOT NULL DEFAULT false,

  -- Mirrors `METERING_FREE_PLAN_ID`.
  "free_plan_id" text NOT NULL DEFAULT 'free',

  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

INSERT INTO "core"."routing_settings" ("id") VALUES (true) ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ⚠ RLS ON WITH A `true` POLICY, WHICH IS A DELIBERATE EXCEPTION AND NOT AN
-- OVERSIGHT. Every other policy in `core` reads `current_setting('app.tenant_id')`
-- because every other table holds tenant data. This holds none — it is global
-- configuration — so there is nothing to scope it by. Enabling RLS anyway keeps
-- the invariant "every table in `core` has RLS" true, so an audit that checks for
-- it does not have to carry an exception list.
ALTER TABLE "core"."routing_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "routing_settings_all" ON "core"."routing_settings"
  FOR ALL USING (true) WITH CHECK (true);
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "core"."routing_settings" TO i10_api;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- The rule, as a pure function.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ⚠ THIS IS A SECOND IMPLEMENTATION OF `resolveRoute` IN src/domains/route.ts,
-- AND THAT IS THE RISK THIS WHOLE BLOCK EXISTS TO MANAGE. The rule has to run
-- inside Postgres because Stalwart asks Postgres; it has to run in TypeScript
-- because the dashboard renders it and the API answers with it. Two
-- implementations of one rule drift, and the drift is silent — the dashboard
-- says `ses` while the mail goes direct, and nobody finds out until somebody
-- compares them by hand.
--
-- ⚠ SO THE CASE TABLE BELOW IS ASSERTED AT MIGRATION TIME, AND THE IDENTICAL
-- TABLE IS ASSERTED AGAINST THE TYPESCRIPT IN test/route.test.ts. They are
-- written in the same order with the same values so the two can be read side by
-- side in a diff. If this function is wrong, the DEPLOY fails here rather than
-- the mail going somewhere nobody chose.
--
-- ⚠ PURE AND `IMMUTABLE` SO IT IS ASSERTABLE AT ALL. Folding the lookups in
-- would make the rule untestable without fixtures, and fixtures in a migration
-- are rows somebody has to remember to delete.
CREATE FUNCTION "core"."resolve_route"(
  p_override text,
  p_plan_id text,
  p_free_plan_id text,
  p_ses_enabled boolean
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    -- ⚠ FIRST, AND IT BEATS AN EXPLICIT `ses` OVERRIDE TOO. The switch exists to
    -- be thrown during an incident; a route a support override could pin past it
    -- would leave exactly the domains somebody cared enough to pin still pointed
    -- at the thing that is down.
    WHEN p_ses_enabled IS NOT TRUE THEN 'direct'
    WHEN p_override <> 'auto' THEN p_override
    -- ⚠ FREE IS THE DEFAULT BRANCH, NOT A SPECIAL CASE. Anything not recognised
    -- as a paid plan lands here, so a plan id renamed in the catalogue cannot
    -- start spending SES money on tenants who pay nothing. A tenant with no plan
    -- is our misconfiguration rather than their fault, and their mail still goes.
    WHEN p_plan_id IS NULL OR p_plan_id = p_free_plan_id THEN 'direct'
    ELSE 'ses'
  END
$$;
--> statement-breakpoint

-- ⚠ THE SAME TABLE AS test/route.test.ts, IN THE SAME ORDER. Keep them that way.
DO $$
BEGIN
  -- The kill switch beats everything, including an explicit override.
  ASSERT core.resolve_route('auto',   'pro',  'free', false) = 'direct';
  ASSERT core.resolve_route('ses',    'pro',  'free', false) = 'direct';
  ASSERT core.resolve_route('direct', 'pro',  'free', false) = 'direct';

  -- An override beats the plan, in both directions.
  ASSERT core.resolve_route('ses',    'free', 'free', true)  = 'ses';
  ASSERT core.resolve_route('direct', 'pro',  'free', true)  = 'direct';

  -- Otherwise the plan decides.
  ASSERT core.resolve_route('auto',   'pro',  'free', true)  = 'ses';
  ASSERT core.resolve_route('auto',   'free', 'free', true)  = 'direct';

  -- No plan, and a plan id nobody recognises, both send direct.
  ASSERT core.resolve_route('auto',   NULL,   'free', true)  = 'direct';
  ASSERT core.resolve_route('auto',   'renamed-in-the-catalogue', 'free', true) = 'ses';
END $$;
--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- What Stalwart actually calls.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Returns the NAME OF A ROUTE, because that is what the expression's result is
-- used for: `eval_if::<String>` then `get_route_or_default(name)`.
--
--   `mx`         a built-in — deliver to the recipient's MX ourselves.
--   `ses-relay`  an `MtaRoute` object defining SES's SMTP endpoint as a smart
--                host. See infra/k8s/i10/stalwart/config/README.md; it is NOT in
--                plan.ndjson yet because it needs SES SMTP credentials.
--
-- ⚠ AN UNKNOWN NAME FALLS BACK TO MX RATHER THAN FAILING, WHICH IS WHY THIS IS
-- SAFE TO SHIP BEFORE THE RELAY EXISTS. `get_route_or_default` in
-- crates/common/src/network/mta.rs answers `MX_GATEWAY` for a name it cannot
-- resolve and logs `Smtp(IdNotFound)`. So the worst case is mail leaving the way
-- it leaves today, with a line in the log — not mail stuck in a queue.
--
-- ⚠ AND `ses_relay_enabled` DEFAULTS FALSE, so this returns `mx` for everybody
-- until somebody turns it on. Shipping the lever does not move any mail.
--
-- ⚠ `sender_domain` IS THE RETURN PATH'S DOMAIN, NOT THE `From:` HEADER'S, AND
-- THAT IS THE TRAP IN THIS WHOLE FEATURE. `QueueEnvelope::resolve_variable` maps
-- `SenderDomain` to `return_path.domain_part()`. For human mail that is the
-- sender's own domain, which is what we want. For OUR OWN transactional mail on
-- the direct route it is `bounce.<domain>` — the VERP envelope — which is not a
-- row in `core.domains` at all.
--
-- ⚠ WHICH MATTERS BECAUSE THIS EXPRESSION SEES EVERY MESSAGE IN THE QUEUE,
-- INCLUDING OURS. A transactional message our worker already decided to send
-- direct must not be re-routed onto SES here: it would leave with a VERP return
-- path SES does not own, break the SPF alignment the direct route was built for,
-- and be signed twice. The `hosts_mailboxes` join is what prevents it — a
-- `bounce.` subdomain matches no row, and a domain that only sends is not a
-- mailbox domain either, so both answer `mx` and the worker's decision stands.
CREATE FUNCTION "core"."mailbox_route"(p_sender_domain text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT CASE
    -- No relay configured, or SES switched off entirely: carry it ourselves.
    WHEN s.ses_enabled IS NOT TRUE OR s.ses_relay_enabled IS NOT TRUE THEN 'mx'
    -- Not a domain we host mailboxes for — including every `bounce.` VERP
    -- subdomain our own transactional mail leaves under. See above.
    WHEN d.name IS NULL THEN 'mx'
    WHEN core.resolve_route(d.mailbox_route::text, pa.plan_id, s.free_plan_id, s.ses_enabled)
         = 'ses' THEN 'ses-relay'
    ELSE 'mx'
  END
    FROM core.routing_settings s
    LEFT JOIN core.domains d
      ON lower(d.name) = lower(p_sender_domain)
     AND d.hosts_mailboxes
    LEFT JOIN core.plan_assignments pa
      ON pa.tenant_id = d.tenant_id
   WHERE s.id
$$;
--> statement-breakpoint

-- ⚠ TO `stalwart`, THE ROLE THAT ALREADY EXISTS AND ALREADY HAS CONNECT ON THIS
-- DATABASE. Creating a role here is not possible — `CREATE ROLE` needs CREATEROLE
-- and migrations connect as `i10`, which does not have it; that is exactly how
-- 0023 failed on its first real run and blocked four migrations behind it.
--
-- ⚠ AND THIS ONE FUNCTION IS THE WHOLE SURFACE. No table grants come with it, so
-- the mail server can ask "which route for this domain" and nothing else. The
-- function is `SECURITY DEFINER` precisely so the caller needs no reach of its
-- own into `core.domains` or `core.plan_assignments`.
GRANT EXECUTE ON FUNCTION "core"."mailbox_route"(text) TO stalwart;
