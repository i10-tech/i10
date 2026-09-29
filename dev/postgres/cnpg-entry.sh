#!/bin/bash
# Starts the production CNPG image as a plain dev database.
#
# ⚠ THE SAME IMAGE AS PRODUCTION, NOT postgres:18-alpine. CloudNativePG's
# `standard` image carries the extensions the cluster actually has (pgvector
# among them) and is Debian/glibc like production - the Alpine image is musl,
# so it sorts text differently and has no pgvector at all. A migration that
# needs an extension, or an index whose order depends on collation, now fails
# here instead of in a PreSync hook.
#
# ⚠ THE IMAGE HAS NO ENTRYPOINT - CNPG's operator bootstraps it in the cluster.
# This script is that bootstrap for a laptop, and it mirrors the cluster's
# roles on purpose:
#   - `postgres` is the only superuser, as in CNPG.
#   - `i10` OWNS the database and is NOT a superuser, exactly like production.
#     Migrations run as it, so a statement that silently needs superuser (a
#     `CREATE EXTENSION` for an untrusted extension, say) fails here too.
#   - Extensions are created by the superuser, which is what CNPG's `Database`
#     resource does in production (infra/k8s/i10/platform-db/database.yaml).
#
# ⚠ RUNS AS ROOT ONLY TO FIX THE VOLUME'S OWNER, then drops to uid 26.
set -euo pipefail

PGDATA=/var/lib/postgresql/data/pgdata
export PGDATA

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$PGDATA"
  chown -R 26:26 /var/lib/postgresql/data
  chmod 700 "$PGDATA"
  exec setpriv --reuid=26 --regid=26 --init-groups "$0" "$@"
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  initdb -D "$PGDATA" -U postgres --auth-local=trust --auth-host=scram-sha-256 \
    --encoding=UTF8 --locale=C.UTF-8 >/dev/null
  echo "listen_addresses = '*'" >>"$PGDATA/postgresql.conf"
  echo "host all all 0.0.0.0/0 scram-sha-256" >>"$PGDATA/pg_hba.conf"
  echo "host all all ::/0 scram-sha-256" >>"$PGDATA/pg_hba.conf"

  pg_ctl -D "$PGDATA" -w -o "-c listen_addresses=''" start >/dev/null
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
ALTER ROLE postgres PASSWORD 'postgres';
CREATE ROLE i10 LOGIN CREATEDB PASSWORD 'i10';
CREATE DATABASE i10 OWNER i10;
SQL
  psql -v ON_ERROR_STOP=1 -U postgres -d i10 -f /docker-entrypoint-initdb.d/10-roles.sql >/dev/null
  psql -v ON_ERROR_STOP=1 -U postgres -d i10 -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null
  # ⚠ ALSO IN template1, so a throwaway database `i10` creates to prove a
  # migration (docs: never touch the dev database) already has it - the
  # non-superuser `i10` could not add it itself, just as in production.
  psql -v ON_ERROR_STOP=1 -U postgres -d template1 -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null
  pg_ctl -D "$PGDATA" -w stop >/dev/null
fi

exec postgres -D "$PGDATA"
