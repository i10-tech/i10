ALTER TABLE "core"."plans" ADD COLUMN "rank" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- ⚠ THE CATALOGUE'S RANKS, AND THE GAP IS DELIBERATE. Free is 0 and Pro is 10
-- so a plan can be inserted between them without renumbering rows that live
-- subscriptions are being compared against — a renumber mid-flight would make
-- an in-progress upgrade read as a downgrade and defer a charge the customer
-- already agreed to.
UPDATE core.plans SET rank = 0 WHERE id = 'free' AND source = 'catalog';
--> statement-breakpoint
UPDATE core.plans SET rank = 10 WHERE id = 'pro' AND source = 'catalog';
