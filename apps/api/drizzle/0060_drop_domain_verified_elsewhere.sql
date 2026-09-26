-- Custom SQL migration file, put your code below! --
-- Nothing asks "is this name verified by another workspace?" any more: adding a
-- domain somebody else holds is allowed, and proving it moves it (0058). The
-- only caller was `domainStore`'s refusal at create, removed with that change.
DROP FUNCTION IF EXISTS "core"."domain_verified_elsewhere"(text, uuid);
