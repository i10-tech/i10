-- Domain limits enter the catalogue.
--
-- ⚠ THE NUMBERS BELOW ARE PLACEHOLDERS AND SOMEBODY HAS TO CHOOSE THEM. They
-- are shaped correctly and they are not a pricing decision anyone has made:
-- one sending domain on free, ten on pro, and mailbox domains as a paid-only
-- feature. Change them here, or from the config push once it exists — this file
-- is a starting value, not a position.
--
-- ⚠ `domains.mailbox` ON FREE IS AN ALLOWANCE OF ZERO, NOT AN ABSENT
-- ENTITLEMENT, AND THE DIFFERENCE REACHES THE CUSTOMER. Granting it at zero
-- means the answer is `exceeded` — "your plan does not include this, upgrade" —
-- which is true and actionable. Leaving it out entirely means `unentitled`,
-- which this codebase reserves for OUR misconfiguration and deliberately fails
-- open. A free tenant would then create mailbox domains unmetered.
--
-- ⚠ AND BOTH ARE `overage: 'never'`. Nobody sells a fourth domain for thirty
-- cents. This is the case the per-entitlement overage policy exists for: the
-- same tenant may bill past their email allowance and still be refused here.
UPDATE core.plans
   SET entitlements = entitlements || '[
         {"kind":"continuous","featureId":"domains.sending",
          "allowance":1,"overage":"never"},
         {"kind":"continuous","featureId":"domains.mailbox",
          "allowance":0,"overage":"never"}
       ]'::jsonb,
       updated_at = now()
 WHERE id = 'free' AND source = 'catalog';
--> statement-breakpoint

UPDATE core.plans
   SET entitlements = entitlements || '[
         {"kind":"continuous","featureId":"domains.sending",
          "allowance":10,"overage":"never"},
         {"kind":"continuous","featureId":"domains.mailbox",
          "allowance":1,"overage":"never"}
       ]'::jsonb,
       updated_at = now()
 WHERE id = 'pro' AND source = 'catalog';
