# syntax=docker/dockerfile:1.7
# ⚠ THE TAG IS PINNED TO THE EXACT VERSION, not `1-alpine` — see
# apps/api/Dockerfile. `.bun-version`, `packageManager`, ci.yml's BUN_VERSION
# and every base image here move together.
FROM oven/bun:1.3.12-alpine AS base

FROM base AS deps
WORKDIR /repo
COPY bun.lock bunfig.toml package.json ./
COPY apps/console/package.json apps/console/
COPY packages/ui/package.json packages/ui/
COPY packages/node/package.json packages/node/
COPY packages/next/package.json packages/next/
COPY packages/contracts/package.json packages/contracts/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/typescript-config/package.json packages/typescript-config/
ENV BUN_INSTALL_CACHE_DIR=/bun-cache
RUN --mount=type=cache,id=bun,target=/bun-cache \
    bun install --frozen-lockfile

FROM deps AS build
WORKDIR /repo
COPY . .
ARG GIT_SHA=dev
ARG BUILD_TIME
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME NEXT_TELEMETRY_DISABLED=1
# ⚠ TURBO, NOT `bun run --filter`. `build` declares `dependsOn: ["^build"]`, so
# the workspace packages this app imports through their `exports` — which point
# at dist/ — are built first and in order. The pnpm command this replaced had
# no `...` suffix and so did NOT build them; it survived on whatever a previous
# stage had left behind, which is exactly the kind of thing that works until it
# does not.
RUN bunx turbo run build --filter=@i10/console

# ═════════════════════════════════════════════════════════════════════════════
# ⚠ NODE, NOT BUN, AND IT IS THE ONLY NODE LEFT IN THIS REPOSITORY.
#
# Everything up to here is bun: the install, the workspace, the build. The
# server process is not, because Next's STANDALONE server.js does not run under
# bun 1.3.12. It boots, prints "Ready", accepts the connection, and then fails
# every render with:
#
#   Failed to load external module
#   next/dist/compiled/next-server/app-page-turbo.runtime.prod.js:
#   TypeError: Expected CommonJS module to have a function wrapper.
#   If you weren't messing around with Bun's internals, this is a bug in Bun
#
# Measured, not assumed — and narrowed: `next dev` and `next start` BOTH serve
# 200 under bun. It is specifically the file `output: "standalone"` emits, whose
# own module loader pulls Next's precompiled CJS runtime in a way bun rejects.
# A `--webpack` build fails identically, so it is not a Turbopack artefact.
#
# The alternatives were both worse. Running `next start` under bun instead means
# shipping the full node_modules tree that `standalone` exists to avoid — see
# the note in next.config.ts. Waiting is not a deploy strategy.
#
# ⚠ RE-TEST THIS ON EVERY BUN UPGRADE, and delete this stage when it passes:
#   cd apps/console/.next/standalone && bun apps/console/server.js
#   curl -s -o /dev/null -w '%{http_code}' localhost:$PORT/   # want 200
# ═════════════════════════════════════════════════════════════════════════════
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000

# ⚠ THE UID IS PINNED, AND NUMERICALLY. `adduser -S` without -u picks the first
# free system UID, which is a property of the base image rather than of us — it
# moves when the base image does. More importantly kubelet cannot verify a
# NAMED user against `runAsNonRoot`: it has no way to resolve the name without
# reading the image's /etc/passwd, so it refuses to start the container with
# "image has non-numeric user". A number is the only form both sides agree on.
RUN addgroup -S -g 1001 i10 && adduser -S -u 1001 -G i10 -h /home/i10 i10 \
    && mkdir -p /home/i10 && chown -R i10:i10 /home/i10
ENV HOME=/home/i10

# The three pieces `output: standalone` splits a build into. static/ and
# public/ are NOT inside the standalone tree — copying only server.js gives a
# site that renders with every stylesheet and image 404ing.
#
# ⚠ standalone STILL CARRIES A node_modules, UNLIKE THE API IMAGE. Next traces
# the server's imports and copies them in; that tree is Next's output, not a
# package manager's, so there is nothing here to flatten or prune and nothing
# that depends on how the workspace was linked.
COPY --from=build --chown=i10:i10 /repo/apps/console/.next/standalone ./
COPY --from=build --chown=i10:i10 /repo/apps/console/.next/static ./apps/console/.next/static
COPY --from=build --chown=i10:i10 /repo/apps/console/public ./apps/console/public

USER 1001:1001
EXPOSE 3000

ARG GIT_SHA=dev
ARG BUILD_TIME
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME

CMD ["node", "apps/console/server.js"]
