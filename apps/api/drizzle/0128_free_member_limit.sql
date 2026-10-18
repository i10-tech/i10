-- The catalogue's member limits (#327): Free 3, Pro 20 (the column default).
-- ⚠ ONLY WHILE STILL AT THE DEFAULT, so a limit somebody set deliberately
-- before this ran is not reverted - the same rule as 0076's retention.
UPDATE core.plans SET member_limit = 3 WHERE id = 'free' AND source = 'catalog' AND member_limit = 20;
