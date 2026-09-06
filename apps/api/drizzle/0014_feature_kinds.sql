ALTER TABLE "core"."plan_assignments" ADD COLUMN "overage_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- The catalogue's entitlements gain a kind and an overage policy.
--
-- ⚠ REWRITTEN RATHER THAN DEFAULTED IN THE PARSER, AND THAT IS THE POINT. The
-- cheap fix for rows seeded by 0012 is to make `kind` optional on read and
-- assume `consumable` — which is exactly the silent default that makes a
-- misconfigured plan behave plausibly instead of failing. The adapter's schema
-- is `strict()` and requires both fields, so a row that did not get this
-- UPDATE raises on the next quota check, by name, in one place.
--
-- ⚠ `emails` IS `overage: 'never'` HERE. Billed overage is a real part of the
-- pricing model and none of it exists yet — no meter, no metered price, no
-- credits benefit, no ingest. A catalogue that promised it before Polar could
-- charge for it would let a customer send past their plan for free and give us
-- no way to invoice for it afterwards. Flip this in the same change that
-- wires the ingest, not before.
UPDATE core.plans
   SET entitlements =
         '[{"kind":"consumable","featureId":"emails","allowance":100,
            "interval":"day","overage":"never"}]'::jsonb,
       updated_at = now()
 WHERE id = 'free' AND source = 'catalog';
--> statement-breakpoint

UPDATE core.plans
   SET entitlements =
         '[{"kind":"consumable","featureId":"emails","allowance":50000,
            "interval":"month","overage":"never"}]'::jsonb,
       updated_at = now()
 WHERE id = 'pro' AND source = 'catalog';
