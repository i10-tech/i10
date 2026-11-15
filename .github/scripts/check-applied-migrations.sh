#!/usr/bin/env bash
# Fails when a pull request changes, renames or deletes an existing file under
# apps/api/drizzle. Adding new migration folders is fine.
#
#   check-applied-migrations.sh <base-sha> <head-sha>
#
# ⚠ AN APPLIED MIGRATION IS IMMUTABLE, COMMENTS INCLUDED. Every database
# records each migration's bytes as a sha256 hash, and drizzle v1 matches its
# rows by that hash. On 2026-09-28 commit 12421fa0 replaced em dashes in the
# comments of 51 applied migrations; nothing noticed for seven weeks, and then
# the v1 upgrade failed in production on the two rows it could only name by
# hash.
#
# ⚠ THREE DOTS, NOT TWO. The base sha is the tip of main when the event fired;
# a two-dot diff against a branch that is behind it would report every
# migration main added since as deleted here.
set -euo pipefail

base="$1"
head="$2"

changed="$(git diff --name-status -M --diff-filter=DMRT "$base...$head" -- apps/api/drizzle)"
if [ -z "$changed" ]; then
  echo "no existing migration was changed"
  exit 0
fi

echo "::error::This pull request changes migrations that already exist:"
echo "$changed"
cat <<'EOF'

Every database that applied a migration records its bytes as a hash, and
drizzle compares that hash. A comment-only edit to applied migrations on
2026-09-28 (12421fa0) broke the drizzle v1 upgrade in production. Put these
files back as they were, and fix forward with a new migration instead.
EOF
exit 1
