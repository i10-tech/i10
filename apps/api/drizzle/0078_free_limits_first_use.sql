-- The free plan's daily limit starts at the first send, not at the anchor
-- (packages/metering, `start: "first_use"`; decided 2026-09-29).
--
-- ⚠ ANCHORED WINDOWS LET A FREE WORKSPACE SEND 100 A MINUTE BEFORE THE RESET
-- AND 100 A MINUTE AFTER IT. A window that opens on the first send has no fixed
-- boundary to wait for. The tier's monthly line (metering/tiers.ts) changes in
-- code, in the same release. Paid plans keep their anchored billing periods.
--
-- ⚠ ONLY THE `emails` CONSUMABLE, AND ONLY ON `free`. Every other entitlement
-- in the array is carried through untouched, in order.
UPDATE core.plans
   SET entitlements = (
         SELECT jsonb_agg(
                  CASE
                    WHEN e->>'featureId' = 'emails' AND e->>'kind' = 'consumable'
                      THEN e || '{"start":"first_use"}'::jsonb
                    ELSE e
                  END
                  ORDER BY ord
                )
           FROM jsonb_array_elements(entitlements) WITH ORDINALITY AS x(e, ord)
       ),
       updated_at = now()
 WHERE id = 'free';
