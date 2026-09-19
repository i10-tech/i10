-- Taking a domain back from a holder who can no longer prove they own it.
--
-- ⚠ PROOF WAS ONE-SHOT, AND DOMAINS CHANGE HANDS. A workspace that proved
-- `example.com` in March keeps the claim and the verified badge for ever — the
-- registration can lapse, somebody else can buy it, and nothing in this system
-- ever asks again. The new owner adds the domain, publishes everything
-- correctly, and is told the name belongs to another workspace; the previous
-- owner meanwhile keeps a verified sending identity for a domain that is not
-- theirs, which is the half that actually matters.
--
-- ⚠ SO A CLAIM IS CONTESTABLE, AND THE CONTEST IS DECIDED BY DNS RATHER THAN BY
-- SUPPORT. A challenger who proves ownership causes the incumbent to be
-- RE-CHECKED against the same public DNS. If the incumbent still proves it,
-- nothing moves — two workspaces of one company both holding the records is a
-- tie, and a tie never grants anything. If the incumbent cannot, the domain
-- moves to whoever can, which is the only answer that stays true as ownership
-- changes.
--
-- ⚠ ALL THREE FUNCTIONS ARE SECURITY DEFINER FOR THE SAME REASON THE REST ARE:
-- `core.domains` is under row level security, so a challenger's own query for
-- the incumbent returns nothing by construction. They return the minimum needed
-- to RE-RUN A DNS CHECK and never reach a customer — the console sees an
-- outcome, never a row.

-- The workspace currently being SERVED for a delegated name.
CREATE FUNCTION "core"."delegation_holder"(p_name text)
RETURNS TABLE (
  domain_id uuid,
  tenant_id uuid,
  delegation_token text,
  dkim_selector text,
  dkim_public_key text,
  delegated boolean,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.id, d.tenant_id, d.delegation_token, d.dkim_selector,
         d.dkim_public_key, d.delegated, d.status::text
    FROM core.delegations dl
    JOIN core.domains d ON d.id = dl.domain_id
   WHERE dl.name = p_name;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."delegation_holder"(text) TO i10_api;
--> statement-breakpoint

-- The workspace currently holding a name as VERIFIED, delegated or not.
--
-- ⚠ THIS IS THE ONE THAT MATTERS FOR A MANUAL DOMAIN, which takes no delegation
-- claim at all: `domains_verified_name_unique` is the whole of its exclusivity,
-- so the blocker is whoever holds that row.
CREATE FUNCTION "core"."verified_holder"(p_name text)
RETURNS TABLE (
  domain_id uuid,
  tenant_id uuid,
  delegation_token text,
  dkim_selector text,
  dkim_public_key text,
  delegated boolean,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.id, d.tenant_id, d.delegation_token, d.dkim_selector,
         d.dkim_public_key, d.delegated, d.status::text
    FROM core.domains d
   WHERE d.name = p_name
     AND d.status = 'verified'
   LIMIT 1;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."verified_holder"(text) TO i10_api;
--> statement-breakpoint

-- Stand a holder down, because public DNS no longer says the domain is theirs.
--
-- ⚠ `failed`, NOT A DELETE, AND NOT `pending`. Their row, their DKIM key and
-- their history stay exactly where they are — we are not entitled to delete a
-- customer's domain because somebody else proved it — but it stops being
-- verified, which is what gates sending. `failed` is also honest in the words
-- the console already uses: their records genuinely no longer resolve.
--
-- ⚠ AND `verified_at` IS LEFT ALONE, because it means "has this ever been
-- proven" and it always will have been. The send path reads `status`.
--
-- ⚠ IT RELEASES THE DELEGATION CLAIM IN THE SAME STATEMENT, so there is no
-- window in which the name is verified by nobody and still served for the
-- person who just lost it.
CREATE FUNCTION "core"."displace_domain"(p_domain_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  DELETE FROM core.delegations WHERE domain_id = p_domain_id;

  UPDATE core.domains
     SET status = 'failed',
         updated_at = now()
   WHERE id = p_domain_id;
END $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."displace_domain"(uuid) TO i10_api;
--> statement-breakpoint

-- How long a verified domain may fail its proof before it is stood down.
--
-- ⚠ A SINGLE ABSENT READING MUST NEVER DEMOTE ANYBODY, which is why this column
-- exists rather than the sweep acting on what it sees. A customer migrating
-- between DNS providers, editing a zone, or briefly mis-pasting a record would
-- otherwise lose a verified domain — and with it the ability to send — because
-- of a lookup that happened during the ninety seconds their zone was wrong.
--
-- ⚠ AND IT IS DELIBERATELY NOT SYMMETRIC WITH THE CONTEST PATH, which demotes
-- immediately. There, somebody else has PROVED the name: that is positive
-- evidence the domain has moved. Here there is no challenger and no evidence of
-- anything except an absence, so absence has to persist before it counts.
ALTER TABLE "core"."domains" ADD COLUMN "proof_missing_since" timestamptz;
--> statement-breakpoint

-- The verified domains whose proof has not been checked recently.
--
-- ⚠ SECURITY DEFINER AND CROSS-TENANT ON PURPOSE, like `sweep_stuck_messages`.
-- A periodic re-check has no tenant context by definition — it is asking a
-- question about every customer at once — and RLS would answer "no domains".
-- It returns only what is needed to RE-RUN A DNS CHECK.
CREATE FUNCTION "core"."domains_due_recheck"(p_before timestamptz, p_limit int)
RETURNS TABLE (
  domain_id uuid,
  tenant_id uuid,
  name text,
  delegated boolean,
  delegation_token text,
  dkim_selector text,
  dkim_public_key text,
  proof_missing_since timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.id, d.tenant_id, d.name, d.delegated, d.delegation_token,
         d.dkim_selector, d.dkim_public_key, d.proof_missing_since
    FROM core.domains d
   WHERE d.status = 'verified'
     AND (d.dns_checked_at IS NULL OR d.dns_checked_at < p_before)
   -- ⚠ OLDEST FIRST, so a run that hits the limit makes progress through the
   -- whole table rather than re-checking the same head of it for ever.
   ORDER BY d.dns_checked_at ASC NULLS FIRST
   LIMIT p_limit;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."domains_due_recheck"(timestamptz, int) TO i10_api;
--> statement-breakpoint

-- Record the outcome of one re-check.
--
-- ⚠ THE CLOCK STARTS ON THE FIRST FAILURE AND IS CLEARED BY ANY SUCCESS, so a
-- domain that flickers never accumulates. `coalesce` is what makes it the FIRST
-- failure rather than the most recent one.
CREATE FUNCTION "core"."note_domain_proof"(p_domain_id uuid, p_proven boolean)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  UPDATE core.domains
     SET dns_checked_at = now(),
         proof_missing_since =
           CASE WHEN p_proven THEN NULL
                ELSE coalesce(proof_missing_since, now()) END
   WHERE id = p_domain_id;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."note_domain_proof"(uuid, boolean) TO i10_api;
