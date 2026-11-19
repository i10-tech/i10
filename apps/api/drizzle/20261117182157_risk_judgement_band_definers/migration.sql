-- The content judge's bands (docs/decisions/risk.md, "Judging before the
-- first send"): a judgement keeps the MinHash bands of the body it judged, so
-- a near-duplicate of that body (the same mail to another name) counts as
-- judged, before the send and in the hourly pass alike.
--
-- ⚠ THE SAVE GAINS A TRAILING `p_bands` WITH A DEFAULT, so a pod still running
-- the previous image during the rollout keeps saving through the old fourteen
-- arguments instead of failing on a function that no longer exists.
DROP FUNCTION "core"."risk_content_judgement_save"(uuid, text, text, jsonb, boolean, integer, integer, "core"."risk_judge_second", text, jsonb, boolean, integer, integer, timestamptz);
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
  p_at timestamptz,
  p_bands text[] DEFAULT NULL
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
     second_input_tokens, second_output_tokens, judged_at, bands)
  VALUES
    (p_tenant, p_exact, p_model, p_answers, p_truncated, p_input_tokens, p_output_tokens,
     p_second_status, p_second_model, p_second_answers, p_second_truncated,
     p_second_input_tokens, p_second_output_tokens, p_at, p_bands)
  ON CONFLICT (tenant_id, exact, model) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END
$$;
--> statement-breakpoint

-- This workspace's judgements under this model since p_since that share at
-- least one band with p_bands, with their bands, so the caller can count how
-- many each shares. Bands only: never the answers.
CREATE FUNCTION "core"."risk_content_judged_near"(
  p_tenant uuid,
  p_model text,
  p_bands text[],
  p_since timestamptz
)
RETURNS TABLE (exact text, bands text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT j.exact, j.bands FROM core.risk_content_judgements j
   WHERE j.tenant_id = p_tenant AND j.model = p_model
     AND j.judged_at >= p_since AND j.bands && p_bands
$$;
--> statement-breakpoint

-- ⚠ FUNCTIONS ARE EXECUTABLE BY PUBLIC UNTIL REVOKED (see 0074). The API, the
-- worker, the hourly job and risk-admin all connect as i10_api.
REVOKE EXECUTE ON FUNCTION
  "core"."risk_content_judgement_save"(uuid, text, text, jsonb, boolean, integer, integer, "core"."risk_judge_second", text, jsonb, boolean, integer, integer, timestamptz, text[]),
  "core"."risk_content_judged_near"(uuid, text, text[], timestamptz)
FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  "core"."risk_content_judgement_save"(uuid, text, text, jsonb, boolean, integer, integer, "core"."risk_judge_second", text, jsonb, boolean, integer, integer, timestamptz, text[]),
  "core"."risk_content_judged_near"(uuid, text, text[], timestamptz)
TO i10_api;
