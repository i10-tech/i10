# Autumn's server image, with three lines changed.
#
# ⚠ WE PATCH CONSTANTS RATHER THAN FORK THE REPO. Every edit below is a single
# line, chosen because upstream hard-codes a value that is correct for THEIR
# deployment — their AWS, their domains — and has no environment variable. None
# of them is a bug in Autumn; they are the seams where "self-hosted" was not a
# case anyone had run.
#
# ⚠ AND EVERY PATCH IS GUARDED SO IT CANNOT SILENTLY STOP WORKING. `grep -q`
# runs BEFORE each edit and fails the build if upstream has reworded the line. A
# sed that quietly matches nothing would restore the old behaviour, and every
# one of these failure modes is invisible until production: an OOM kill weeks
# later, or a browser console nobody is looking at.
ARG BASE
FROM ${BASE}

# ────────────────────────────────────────────────────────────────────────────
# 1. Worker process count — a memory decision.
#
# `server/src/workers.ts` hard-codes it:
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
# Replaced with an environment variable rather than a constant, so the count is
# configuration in the Deployment instead of another image build.
RUN set -eux; \
    f=/app/server/src/workers.ts; \
    grep -q 'const NUM_PROCESSES = process.env.NODE_ENV === "development" ? 3 : 4;' "$f"; \
    sed -i 's|const NUM_PROCESSES = process.env.NODE_ENV === "development" ? 3 : 4;|const NUM_PROCESSES = Math.max(1, Number(process.env.AUTUMN_WORKER_PROCESSES ?? 1));|' "$f"; \
    grep -n 'NUM_PROCESSES =' "$f"

# ────────────────────────────────────────────────────────────────────────────
# 2 and 3. The dashboard's own origin — WITHOUT THESE, SELF-HOSTING CANNOT SIGN
# ANYONE IN, and the only symptom is a browser console.
#
# Two independent gates decide whether a browser request from our dashboard is
# allowed, and in production BOTH are hard-coded lists of Autumn's own domains:
#
#   utils/corsOrigins.ts   ALLOWED_ORIGINS — app.useautumn.com, staging, dev,
#                          checkout, plus localhost. `isAllowedOrigin` returns
#                          undefined for anything else once NODE_ENV is
#                          production, so Hono's cors() emits no
#                          Access-Control-Allow-Origin and the BROWSER blocks
#                          the request before it is sent.
#
#   utils/auth.ts          Better Auth's `trustedOrigins`. It does read
#                          CLIENT_URL — but four lines BELOW an
#                          `if (NODE_ENV === "production") return origins`, so
#                          in production it is dead code. This is the CSRF
#                          check, enforced SERVER-side.
#
# ⚠ WHICH IS WHY THE EDGE CANNOT FIX THIS. Adding
# Access-Control-Allow-Origin in Traefik satisfies the first gate and then
# fails the second, with a 403 from Better Auth instead of a CORS error —
# the same dead end, one layer deeper. The origin has to be trusted inside
# the process.
#
# What it looked like: billing.i10.tech answered "Couldn't check how your
# organization signs in" on the sign-in form. That message is the dashboard's
# handler for a failed POST to /auth/sso/resolve — a request that never left
# the browser.
#
# Both patches take the origin from CLIENT_URL, which the Deployment already
# sets, normalised: an Origin header never carries a trailing slash, so
# `https://billing.i10.tech/` in Doppler would match nothing and look exactly
# like this bug all over again.
RUN set -eux; \
    f=/app/server/src/utils/corsOrigins.ts; \
    grep -q '"https://localhost:8080",' "$f"; \
    sed -i 's|"https://localhost:8080",|&\n\t...(process.env.CLIENT_URL ? [process.env.CLIENT_URL.trim().replace(/[/]+$/, "")] : []),|' "$f"; \
    grep -n 'CLIENT_URL' "$f"

# `authBaseUrl` (AUTUMN_API_URL) moves up with it: upstream pushes both
# together below the early return, and Better Auth checks its own base URL as
# an origin for same-origin callbacks.
RUN set -eux; \
    f=/app/server/src/utils/auth.ts; \
    grep -q 'if (process.env.NODE_ENV === "production") return origins;' "$f"; \
    sed -i 's|if (process.env.NODE_ENV === "production") return origins;|if (process.env.CLIENT_URL) origins.push(process.env.CLIENT_URL.trim().replace(/[/]+$/, ""));\n\t\tif (authBaseUrl) origins.push(authBaseUrl);\n\t\t&|' "$f"; \
    grep -n 'origins.push' "$f"
