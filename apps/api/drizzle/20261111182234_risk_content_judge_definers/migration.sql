-- The content judge (docs/decisions/risk.md, "The content judge"): its
-- judgements and its daily counts.
--
-- ⚠ BOTH TABLES ARE DENY-ALL, SO THESE ARE THEIR ONLY DOORS, like the fact
-- snapshots' and the staff decisions'. Exact probabilities are staff's: a
-- workspace that could read them could tune its mail against the judge.

-- Which of these contents this workspace already has a judgement for, under
-- this model.
CREATE FUNCTION "core"."risk_content_judged_exacts"(p_tenant uuid, p_model text, p_exacts text[])
RETURNS TABLE (exact text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT j.exact FROM core.risk_content_judgements j
   WHERE j.tenant_id = p_tenant AND j.model = p_model AND j.exact = ANY (p_exacts)
$$;
--> statement-breakpoint

-- Records one judgement. ⚠ THE FIRST ONE WINS: two passes judging the same
-- content at once keep one row, and the function says whether it wrote.
CREATE FUNCTION "core"."risk_content_judgement_save"(
  p_tenant uuid,
  p_exact text,
  p_model text,
  p_answers jsonb,
  p_truncated boolean,
  p_input_tokens integer,
  p_output_tokens integer,
  p_second_status "core"."risk_judge_second",
  p_second_model text,
  p_second_answers jsonb,
  p_second_truncated boolean,
  p_second_input_tokens integer,
  p_second_output_tokens integer,
  p_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF jsonb_typeof(p_answers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'a judgement needs its answers';
  END IF;
  IF (p_second_status = 'answered') <> (p_second_answers IS NOT NULL) THEN
    RAISE EXCEPTION 'second answers go with an answered second opinion, and only with one';
  END IF;
  INSERT INTO core.risk_content_judgements
    (tenant_id, exact, model, answers, truncated, input_tokens, output_tokens,
     second_status, second_model, second_answers, second_truncated,
     second_input_tokens, second_output_tokens, judged_at)
  VALUES
    (p_tenant, p_exact, p_model, p_answers, p_truncated, p_input_tokens, p_output_tokens,
     p_second_status, p_second_model, p_second_answers, p_second_truncated,
     p_second_input_tokens, p_second_output_tokens, p_at)
  ON CONFLICT (tenant_id, exact, model) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END
$$;
--> statement-breakpoint

-- The judged contents this workspace sent since p_since, with their messages,
-- for the facts. ⚠ SENT IN THE WINDOW, NOT JUDGED IN IT: a template judged a
-- fortnight ago and sent today counts today. Content whose every fingerprint
-- in the window is trusted (an approved template, boilerplate) is left out.
CREATE FUNCTION "core"."risk_content_judged"(p_tenant uuid, p_model text, p_since date)
RETURNS TABLE (
  exact text,
  answers jsonb,
  truncated boolean,
  second_status "core"."risk_judge_second",
  second_answers jsonb,
  messages integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH sent AS (
    SELECT f.exact, sum(f.messages)::int AS messages,
           bool_and(f.trusted_by IS NOT NULL) AS trusted
      FROM core.content_fingerprints f
     WHERE f.tenant_id = p_tenant AND f.day >= p_since
     GROUP BY f.exact
  )
  SELECT j.exact, j.answers, j.truncated, j.second_status, j.second_answers, s.messages
    FROM core.risk_content_judgements j
    JOIN sent s ON s.exact = j.exact
   WHERE j.tenant_id = p_tenant AND j.model = p_model AND NOT s.trusted
   ORDER BY j.exact
$$;
--> statement-breakpoint

-- Adds one pass's counts to the workspace's day.
CREATE FUNCTION "core"."risk_content_judge_days_add"(
  p_tenant uuid,
  p_day date,
  p_seen integer,
  p_judged integer,
  p_capped integer
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  INSERT INTO core.risk_content_judge_days (tenant_id, day, seen, judged, capped)
  VALUES (p_tenant, p_day, p_seen, p_judged, p_capped)
  ON CONFLICT (tenant_id, day) DO UPDATE
    SET seen = core.risk_content_judge_days.seen + excluded.seen,
        judged = core.risk_content_judge_days.judged + excluded.judged,
        capped = core.risk_content_judge_days.capped + excluded.capped
$$;
--> statement-breakpoint

CREATE FUNCTION "core"."risk_content_judge_days_sum"(p_tenant uuid, p_since date)
RETURNS TABLE (seen integer, judged integer, capped integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT coalesce(sum(d.seen), 0)::int, coalesce(sum(d.judged), 0)::int,
         coalesce(sum(d.capped), 0)::int
    FROM core.risk_content_judge_days d
   WHERE d.tenant_id = p_tenant AND d.day >= p_since
$$;
--> statement-breakpoint

-- A workspace's judgements, newest first, for `risk-admin judge`.
CREATE FUNCTION "core"."risk_content_judgements_list"(p_tenant uuid, p_limit integer)
RETURNS TABLE (
  exact text,
  model text,
  answers jsonb,
  truncated boolean,
  input_tokens integer,
  output_tokens integer,
  second_status "core"."risk_judge_second",
  second_model text,
  second_answers jsonb,
  second_truncated boolean,
  judged_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT j.exact, j.model, j.answers, j.truncated, j.input_tokens, j.output_tokens,
         j.second_status, j.second_model, j.second_answers, j.second_truncated, j.judged_at
    FROM core.risk_content_judgements j
   WHERE j.tenant_id = p_tenant
   ORDER BY j.judged_at DESC, j.exact
   LIMIT p_limit
$$;
--> statement-breakpoint

-- Judgements made before p_before, and day counts older than its day.
CREATE FUNCTION "core"."risk_content_judgements_purge"(p_before timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  DELETE FROM core.risk_content_judgements WHERE judged_at < p_before;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  DELETE FROM core.risk_content_judge_days WHERE day < p_before::date;
  RETURN v_rows;
END
$$;
--> statement-breakpoint

-- ⚠ FUNCTIONS ARE EXECUTABLE BY PUBLIC UNTIL REVOKED (see 0074). The API, the
-- hourly job and risk-admin all connect as i10_api.
REVOKE EXECUTE ON FUNCTION
  "core"."risk_content_judged_exacts"(uuid, text, text[]),
  "core"."risk_content_judgement_save"(uuid, text, text, jsonb, boolean, integer, integer, "core"."risk_judge_second", text, jsonb, boolean, integer, integer, timestamptz),
  "core"."risk_content_judged"(uuid, text, date),
  "core"."risk_content_judge_days_add"(uuid, date, integer, integer, integer),
  "core"."risk_content_judge_days_sum"(uuid, date),
  "core"."risk_content_judgements_list"(uuid, integer),
  "core"."risk_content_judgements_purge"(timestamptz)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  "core"."risk_content_judged_exacts"(uuid, text, text[]),
  "core"."risk_content_judgement_save"(uuid, text, text, jsonb, boolean, integer, integer, "core"."risk_judge_second", text, jsonb, boolean, integer, integer, timestamptz),
  "core"."risk_content_judged"(uuid, text, date),
  "core"."risk_content_judge_days_add"(uuid, date, integer, integer, integer),
  "core"."risk_content_judge_days_sum"(uuid, date),
  "core"."risk_content_judgements_list"(uuid, integer),
  "core"."risk_content_judgements_purge"(timestamptz)
TO i10_api;
