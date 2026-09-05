-- Storage and mailbox limits enter the catalogue.
--
-- ⚠ THE NUMBERS ARE PLACEHOLDERS, LIKE THE DOMAIN LIMITS IN 0015. They are
-- shaped correctly and nobody has made this pricing decision: free hosts no
-- mailboxes at all, pro gets one seat and ten gigabytes.
--
-- ⚠ STORAGE IS IN BYTES, NOT GIGABYTES, AND THAT IS DELIBERATE. Rounding to GB
-- forces a choice between a ceiling — one byte past ten gigabytes reads as
-- eleven and refuses — and a floor, which hands out up to a gigabyte free.
-- Neither is defensible on a cap. 10737418240 is 10 GiB; 0 is none.
--
-- ⚠ AND `mailboxes` ON FREE IS AN ALLOWANCE OF ZERO, NOT AN ABSENT
-- ENTITLEMENT. Zero answers `exceeded` — "your plan does not include this" —
-- which is true and actionable. Leaving it out answers `unentitled`, which this
-- codebase reserves for OUR misconfiguration and deliberately fails open, so a
-- free tenant would create mailboxes unmetered.
UPDATE core.plans
   SET entitlements = entitlements || '[
         {"kind":"continuous","featureId":"mailboxes",
          "allowance":0,"overage":"never"},
         {"kind":"continuous","featureId":"storage.bytes",
          "allowance":0,"overage":"never"}
       ]'::jsonb,
       updated_at = now()
 WHERE id = 'free' AND source = 'catalog';
--> statement-breakpoint

UPDATE core.plans
   SET entitlements = entitlements || '[
         {"kind":"continuous","featureId":"mailboxes",
          "allowance":1,"overage":"never"},
         {"kind":"continuous","featureId":"storage.bytes",
          "allowance":10737418240,"overage":"never"}
       ]'::jsonb,
       updated_at = now()
 WHERE id = 'pro' AND source = 'catalog';
