-- pgvector, for the risk engine's similarity layer (#170).
--
-- ⚠ `IF NOT EXISTS`, AND IN PRODUCTION IT MUST ALREADY EXIST. pgvector is not
-- a trusted extension, so only a superuser can create it - and migrations run
-- as `i10`, the owner, which is not one. CNPG creates it declaratively
-- (infra/k8s/i10/platform-db/database.yaml) and the dev bootstrap does the same
-- (dev/postgres/cnpg-entry.sh). When it exists this is a no-op; when it does
-- not, it fails loudly here, before any table that needs the type, rather than
-- halfway through the next migration.
CREATE EXTENSION IF NOT EXISTS vector;
