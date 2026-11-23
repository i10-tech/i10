-- The mail front reads what the bind reads (`projection.accountColumns`), and
-- that now includes a managed account's connection's pass-through version
-- (`authd.passthrough_versions`, the migration before this one). Read only,
-- like the rest of its grants (20261121202840_mailfront_role_grants, which
-- explains why it has no default privileges). `authd` reads it through the
-- default privileges its schema already grants it.
GRANT SELECT ON authd.passthrough_versions TO mailfront;
