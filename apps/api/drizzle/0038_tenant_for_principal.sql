-- The one question the console asks before it has a tenant.
--
-- ⚠ THE SAME CHICKEN-AND-EGG 0011 AND 0032 DESCRIBE, ARRIVING FROM A THIRD
-- DIRECTION. `core.tenants` is protected by `id = current_setting('app.tenant_id')`,
-- and the console's whole first request is "which tenant is this person's?" —
-- so the caller would have to know the answer to be allowed to ask. A definer
-- function is the only shape that works, and it is held to the same rule as its
-- four siblings: one narrow question, answered by the owner, returning the
-- minimum. The id alone.
--
-- ⚠ IT IS NOT AN AUTHORISATION CHECK AND MUST NEVER BE MISTAKEN FOR ONE. Both
-- arguments come from a Clerk session that `clerk.authenticateRequest` has
-- already verified — Clerk is what proves the person is signed in and what
-- proves the active organization is one they belong to. This function TRANSLATES
-- a verified principal into our id for it. Passing it an org id from a request
-- body would hand any signed-in person any tenant, which is why the only caller
-- is `requireTenant` and why that middleware reads both values from the
-- verified claims and nowhere else.
--
-- ⚠ AND THE ORGANIZATION WINS WHEN ONE IS ACTIVE, WITH NO FALLBACK. Somebody
-- who has switched to "Acme" in Clerk's switcher is asking about Acme's mail.
-- If Acme has no tenant row yet — a sign-up mid-flight, a webhook still in
-- Svix's retry queue — the honest answer is NULL, and the console provisions
-- and retries. Falling back to their personal tenant would quietly show them
-- their own domains under Acme's name, and the first they would know of it is
-- sending a customer's mail from the wrong account.
CREATE FUNCTION "core"."tenant_for_principal"(
  p_clerk_user_id text,
  p_clerk_org_id text
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT t.id
    FROM core.tenants t
   WHERE t.status <> 'deleted'
     AND CASE
           WHEN p_clerk_org_id IS NOT NULL AND p_clerk_org_id <> ''
             THEN t.clerk_org_id = p_clerk_org_id
           -- ⚠ NO ACTIVE ORGANIZATION: THE PERSONAL ONE, AND ONLY IF THEY OWN
           -- IT. Every user gets a personal Clerk organization on `user.created`
           -- (see tenants/provision.ts), so this branch is the ordinary case for
           -- a solo developer whose session has never activated anything.
           -- Requiring ownership is what stops it from resolving to a TEAM
           -- tenant somebody merely belongs to — membership is Clerk's to
           -- assert, through `p_clerk_org_id`, and inferring it here would be a
           -- second and weaker implementation of a rule Clerk already enforces.
           ELSE t.owner_clerk_user_id = p_clerk_user_id
         END
   -- ⚠ OLDEST FIRST, WHICH RESOLVES THE ONE AMBIGUOUS CASE DETERMINISTICALLY.
   -- Somebody who created a team organization by hand owns two tenants and may
   -- have neither active. Their personal organization is the older row by
   -- construction — it is made during sign-up — so this picks the account they
   -- would expect, and picks the SAME one on every request rather than
   -- whichever the planner happened to return first.
   ORDER BY t.created_at
   LIMIT 1
$$;
--> statement-breakpoint
-- ⚠ REVOKED FROM PUBLIC BEFORE IT IS GRANTED, BECAUSE POSTGRES GRANTS EXECUTE
-- ON A NEW FUNCTION TO PUBLIC BY DEFAULT. This one is SECURITY DEFINER: it runs
-- as its owner and answers "which tenant is this principal", which is exactly
-- the lookup RLS exists to prevent anybody doing for themselves. Leaving the
-- default in place would mean every role in the database — including any future
-- read-only or analytics login — could call it. Same rule 0002 follows for
-- `sweep_stuck_messages`.
REVOKE EXECUTE ON FUNCTION "core"."tenant_for_principal"(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."tenant_for_principal"(text, text) TO i10_api;
--> statement-breakpoint

-- What the console shows on the overview, and why it is a definer too.
--
-- ⚠ THIS ONE IS *NOT* CROSS-TENANT AND DOES NOT NEED TO BE — it exists for
-- speed, not for reach. Six aggregates over a partitioned table, each of which
-- the ordinary policy would allow, issued as six round trips on the first
-- screen a person sees. One function is one round trip, and it takes the tenant
-- id as an argument rather than reading `app.tenant_id`, so it cannot be called
-- for a tenant the caller is not already scoped to.
--
-- ⚠ AND IT IS `SECURITY INVOKER`, DELIBERATELY, WHICH IS THE WHOLE POINT OF THE
-- PARAGRAPH ABOVE. Row level security still applies inside it exactly as it
-- would to the same SQL inlined in the application, so a caller that passed
-- somebody else's tenant id gets zero rows rather than their numbers. Making it
-- a definer "for consistency" with its neighbours would turn a performance
-- helper into a cross-tenant read.
CREATE FUNCTION "core"."message_stats"(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  bucket timestamptz,
  sent bigint,
  delivered bigint,
  bounced bigint,
  complained bigint,
  delayed bigint,
  failed bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = core, pg_temp
AS $$
  -- ⚠ `generate_series` ON THE LEFT, SO EMPTY DAYS ARE ROWS RATHER THAN GAPS.
  -- A chart built from only the days that have data draws a straight line
  -- across a weekend of zero sends and reports it as steady volume. The left
  -- join is what makes a quiet day look quiet.
  SELECT
    d.bucket,
    coalesce(e.sent, 0)       AS sent,
    coalesce(e.delivered, 0)  AS delivered,
    coalesce(e.bounced, 0)    AS bounced,
    coalesce(e.complained, 0) AS complained,
    coalesce(e.delayed, 0)    AS delayed,
    coalesce(e.failed, 0)     AS failed
  FROM generate_series(
         date_trunc('day', p_from),
         date_trunc('day', p_to),
         interval '1 day'
       ) AS d(bucket)
  LEFT JOIN (
    SELECT
      date_trunc('day', me.occurred_at) AS bucket,
      count(*) FILTER (WHERE me.type = 'sent')             AS sent,
      count(*) FILTER (WHERE me.type = 'delivered')        AS delivered,
      count(*) FILTER (WHERE me.type = 'bounced')          AS bounced,
      count(*) FILTER (WHERE me.type = 'complained')       AS complained,
      count(*) FILTER (WHERE me.type = 'delivery_delayed') AS delayed,
      count(*) FILTER (WHERE me.type IN ('failed', 'rejected')) AS failed
    FROM core.message_events me
    WHERE me.tenant_id = p_tenant_id
      -- ⚠ TRUNCATED TO MATCH THE SERIES ABOVE, WHICH IS THE WHOLE POINT. The
      -- series starts at `date_trunc('day', p_from)` — midnight — while this
      -- filter used the raw `p_from`, which callers pass as "now minus N days"
      -- and is therefore mid-afternoon. The oldest bucket then counted only the
      -- part of that day after the current time of day and rendered as a dip at
      -- the left edge of the chart: a fabricated drop in volume, on the first
      -- screen after sign-in, that moves depending on what time you look.
      AND me.occurred_at >= date_trunc('day', p_from)
      AND me.occurred_at < p_to + interval '1 day'
    GROUP BY 1
  ) AS e ON e.bucket = d.bucket
  ORDER BY d.bucket
$$;
--> statement-breakpoint
-- ⚠ THE SAME REVOKE, THOUGH THIS ONE IS SECURITY INVOKER AND RLS ALREADY
-- CONSTRAINS IT. Uniformity is the point: a reader who sees one function
-- revoked and the next not has to work out whether that is deliberate.
REVOKE EXECUTE ON FUNCTION "core"."message_stats"(uuid, timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."message_stats"(uuid, timestamptz, timestamptz) TO i10_api;
