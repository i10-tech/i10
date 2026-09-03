# Autumn's server image, with one line changed.
#
# ⚠ WE PATCH A CONSTANT RATHER THAN FORK THE REPO, AND THE DIFFERENCE MATTERS.
# `server/src/workers.ts` hard-codes how many worker processes to run:
#
#   const NUM_PROCESSES = process.env.NODE_ENV === "development" ? 3 : 4;
#
# Four processes, each loading Autumn's entire module graph — Stripe, Drizzle,
# ioredis, OpenTelemetry, Sentry, Better Auth, DuckDB, S3, Svix — at about
# 470 MB apiece. Measured on this cluster: four processes hold 1875 MiB, one
# holds 630 MiB. That 1.2 GB is the difference between Autumn fitting on this
# box and OOM-killing Postgres next to it.
#
# ⚠ WHY NOT STRIP DEPENDENCIES INSTEAD. Stripe appears in 403 files and 15,081
# references — Autumn IS a Stripe-native billing engine, and their own
# self-hosting guide lists a Stripe account as a prerequisite. Removing it is
# not dependency pruning, it is rewriting the product. Sentry is only 17 files
# but would save perhaps 30 MB per process. The cost is per-process baseline,
# so the process count is the only lever with real leverage behind it.
#
# ⚠ AND THE PATCH IS GUARDED SO IT CANNOT SILENTLY STOP WORKING. `grep -q` runs
# BEFORE the edit and fails the build if upstream has reworded that line. A sed
# that quietly matches nothing would put four processes back and the symptom
# would be an OOM kill weeks later, with nothing pointing here.
ARG BASE
FROM ${BASE}

# Replaced with an environment variable rather than a constant, so the count is
# configuration in the Deployment instead of another image build.
RUN set -eux; \
    f=/app/server/src/workers.ts; \
    grep -q 'const NUM_PROCESSES = process.env.NODE_ENV === "development" ? 3 : 4;' "$f"; \
    sed -i 's|const NUM_PROCESSES = process.env.NODE_ENV === "development" ? 3 : 4;|const NUM_PROCESSES = Math.max(1, Number(process.env.AUTUMN_WORKER_PROCESSES ?? 1));|' "$f"; \
    grep -n 'NUM_PROCESSES =' "$f"
