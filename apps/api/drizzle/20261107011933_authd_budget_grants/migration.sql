-- The one table the `authd` role may write.
--
-- 0001 gave authd SELECT and nothing else, on purpose: it parses
-- attacker-influenced input (logins and passwords from any IMAP client) and its
-- blast radius should stop at reading the projection. The failure budget is the
-- exception. authd has to count the failed passwords it forwards to an identity
-- provider, and the count has to be shared by every Stalwart pod, so it cannot
-- live in authd's memory.
--
-- ⚠ INSERT AND UPDATE ON THIS TABLE ONLY. No DELETE (rows are tiny and
-- self-resetting), and no grant on any other table in the schema. The default
-- privileges from 0001 already give authd SELECT on the new table, which the
-- upsert's conflict check and RETURNING need.
--
-- ⚠ DO NOT WIDEN THIS TO `ALL TABLES`. That would hand a role that parses
-- hostile input the right to rewrite the projection it exists to read.

GRANT INSERT, UPDATE ON authd.bind_failure_budget TO authd;
