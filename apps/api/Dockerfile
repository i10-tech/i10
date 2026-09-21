# syntax=docker/dockerfile:1.7

# alpine, not the debian-based default. PSL tried node:slim across all three of
# its images and reverted; alpine was the deliberate choice then and the reason
# has not changed with the runtime.
#
# ⚠ THE TAG IS PINNED TO THE EXACT VERSION, not `1-alpine`. Four places hold
# this version — `.bun-version`, `packageManager` in package.json, BUN_VERSION
# in ci.yml, and every Dockerfile base image — and they move together. A
# floating major would let the image drift away from what CI tested.
FROM oven/bun:1.4.2-alpine AS base

FROM base AS deps
WORKDIR /repo
# Copy only what the resolver needs, so a source edit does not invalidate the
# install layer.
COPY bun.lock bunfig.toml package.json ./

# ⚠ EVERY WORKSPACE MANIFEST, NOT JUST THIS APP'S DEPENDENCIES. The build stage
# does `COPY . .`, which brings in the manifests this stage skipped. bun then
# sees a workspace larger than the one it installed and re-resolves mid-build —
# which fails against `--frozen-lockfile`, with the error pointing at the build
# script rather than at the missing manifests. Listing them all keeps the deps
# layer cacheable and keeps that check quiet.
COPY apps/api/package.json apps/api/
COPY apps/auth/package.json apps/auth/
COPY apps/console/package.json apps/console/
COPY apps/docs/package.json apps/docs/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/dns-providers/package.json packages/dns-providers/
COPY packages/emails/package.json packages/emails/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/metering/package.json packages/metering/
COPY packages/next/package.json packages/next/
COPY packages/node/package.json packages/node/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/ui/package.json packages/ui/
# BUN_INSTALL_CACHE_DIR is set explicitly rather than left to default under
# $HOME, so the cache mount below targets a path that does not move when the
# stage's user does.
ENV BUN_INSTALL_CACHE_DIR=/bun-cache
RUN --mount=type=cache,id=bun,target=/bun-cache \
    bun install --frozen-lockfile

FROM deps AS build
WORKDIR /repo
COPY . .
# ⚠ TURBO, NOT A HAND-WRITTEN LIST OF PACKAGES. `build` declares
# `dependsOn: ["^build"]`, so this one filter builds @repo/contracts,
# @repo/emails and @repo/metering first, in topological order. It replaces
# pnpm's `--filter "@i10/api..."`, whose `...` suffix meant the same thing —
# and the failure mode if the dependencies are skipped is not a build error but
# a runtime one, because `bun build` would resolve @repo/contracts through its
# `exports` to a dist/ that does not exist yet.
RUN bunx turbo run build --filter=@i10/api

# ⚠ EVERY ENTRYPOINT THE MANIFESTS NAME, ASSERTED HERE, BECAUSE THE LAYOUT OF
# dist/ IS NOT STABLE AND MOVED ONCE WITHOUT ANYTHING NOTICING. `bun build`
# derives its output root from the COMMON ANCESTOR of the entrypoints unless
# `--root` says otherwise — so adding one more `src/*.ts` to the build script
# silently moved all nine outputs from `dist/x.js` to `dist/src/x.js`. The build
# succeeded, CI went green, the image pushed, and every Deployment and CronJob
# in it then died with `Module not found "dist/migrate.js"`. The PreSync
# migration hook is one of them, so the failure also wedged Argo: no sync could
# complete, and the fixed image could not be rolled out by the usual path.
#
# ⚠ `--root=src` IN THE BUILD SCRIPT IS THE FIX; THIS IS THE TRIPWIRE. The flag
# pins the root so the entry set cannot move the output, and these lines fail
# the IMAGE BUILD rather than the cluster if it ever moves again. A runtime
# `Module not found` is the most expensive possible place to learn this.
#
# Keep in step with the `command:` lines in infra/k8s/i10/workloads/*.yaml.
RUN set -eu; \
    for entry in index worker migrate sweep reconcile recheck \
                 domain-catchup domain-prove domain-orphans; do \
      if [ ! -f "apps/api/dist/${entry}.js" ]; then \
        echo "dist/${entry}.js is missing — bun build moved the output layout."; \
        echo "Found instead:"; ls apps/api/dist; \
        exit 1; \
      fi; \
    done

# ⚠ NO node_modules IN THE RUNTIME STAGE, AND NOTHING TO FLATTEN ONE WITH.
# The pnpm image ran `pnpm deploy --prod --legacy /app` to turn the workspace
# into a self-contained tree; `bun build` bundles instead, so dist/ has no
# imports left to resolve and the runtime image is the bun binary plus a few
# JavaScript files.
# ⚠ `command -v node` INSIDE THIS IMAGE ANSWERS WITH A PATH, AND IT IS NOT
# NODE. oven/bun ships /usr/local/bun-node-fallback-bin/node as a symlink to
# bun, so third-party tooling that shells out to `node` keeps working. There is
# no Node runtime in any i10 image; do not read that path as evidence of one.
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production

# A writable HOME. Tooling writes to $HOME at startup, and a non-root user
# without one exits EACCES at boot — a failure that reads like a permissions
# bug in the app.
# ⚠ THE UID IS PINNED, AND NUMERICALLY. `adduser -S` without -u picks the first
# free system UID, which is a property of the base image rather than of us — it
# moves when the base image does. More importantly kubelet cannot verify a
# NAMED user against `runAsNonRoot`: it has no way to resolve the name without
# reading the image's /etc/passwd, so it refuses to start the container with
# "image has non-numeric user". A number is the only form both sides agree on.
#
# ⚠ AND THE BASE IMAGE ALREADY HAS A `bun` USER AT 1000. That is not the one
# the manifests name, so it is left alone rather than reused.
RUN addgroup -S -g 1001 i10 && adduser -S -u 1001 -G i10 -h /home/i10 i10 \
    && mkdir -p /home/i10 && chown -R i10:i10 /home/i10
ENV HOME=/home/i10

COPY --from=build --chown=i10:i10 /repo/apps/api/dist /app/dist

# ⚠ THE MIGRATIONS SHIP IN THE IMAGE. dist/migrate.js resolves them relative to
# itself, and the PreSync hook Job runs from this same image so the schema and
# the code that expects it are always the same artifact. Without this COPY the
# Job starts, finds an empty folder, reports "migrations applied", and changes
# nothing — a silent no-op is the worst possible outcome for a migration step.
COPY --from=build --chown=i10:i10 /repo/apps/api/drizzle /app/drizzle

# ⚠ groupmq's LUA SCRIPTS SHIP BESIDE THE BUNDLE, AND WITHOUT THIS EVERY QUEUE
# IN THE SYSTEM IS DEAD. groupmq does not inline its scripts; it reads them off
# disk at first use, resolving them relative to `import.meta.url`:
#
#     candidates = [ <dir>/<name>.lua, <dir>/lua/<name>.lua ]
#
# Under pnpm that `<dir>` was `/app/node_modules/groupmq/dist`, with the scripts
# sitting right there. `bun build` erases that layout — the library is inlined
# into the bundle, so `<dir>` becomes `/app/dist` and the runtime stage has no
# node_modules to fall back to. Both candidates miss and the library throws
# `ENOENT ... /app/dist/enqueue.lua` on the FIRST Redis call.
#
# ⚠ AND IT FAILS AS SILENCE, NOT AS A CRASH, WHICH IS WHY IT COST A DAY. The
# api answers 200 and logs "enqueue failed after commit — the sweep will pick
# these up"; the worker stays Running with every probe green while `reserveBatch`
# throws on every loop; `/internal/queue-depth` 500s because `getJobCounts()` is
# three more of these scripts, which is what leaves the KEDA ScaledObject in
# TriggerError and `i10-workloads` Degraded. Nothing restarts, nothing pages,
# and no mail moves.
#
# `dist/lua/` is the SECOND candidate, chosen over scattering thirty files next
# to the bundle. The guard is not decoration: a silently empty directory here
# reproduces the exact failure this COPY exists to prevent, and `linker =
# "hoisted"` in bunfig.toml is what makes this a real directory rather than a
# symlink into bun's store.
COPY --from=build --chown=i10:i10 /repo/node_modules/groupmq/dist/lua /app/dist/lua
RUN test -s /app/dist/lua/enqueue.lua && test -s /app/dist/lua/reserve-batch.lua

USER 1001:1001
EXPOSE 3001

# Baked at build time and reported by /version. Not part of turbo's cache key —
# a promotion re-tags the same artifact, so one image serves both environments
# and learns which it is at runtime.
ARG GIT_SHA=dev
ARG BUILD_TIME
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME

CMD ["bun", "dist/index.js"]
