-- Free gets three sending domains, not one.
--
-- 0015 seeded 1 as an explicitly-flagged placeholder; this is the number that
-- was actually chosen. It is a `jsonb_set` on the one element rather than a
-- rewrite of the array, so it does not silently discard anything added to that
-- plan between the two migrations.
UPDATE core.plans
   SET entitlements = (
         SELECT jsonb_agg(
                  CASE WHEN e->>'featureId' = 'domains.sending'
                       THEN jsonb_set(e, '{allowance}', '3'::jsonb)
                       ELSE e
                  END
                )
           FROM jsonb_array_elements(entitlements) AS e
       ),
       updated_at = now()
 WHERE id = 'free' AND source = 'catalog';
