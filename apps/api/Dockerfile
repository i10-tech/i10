# syntax=docker/dockerfile:1.7

# alpine, not slim. PSL tried node:slim across all three of its images and
# reverted — alpine is the deliberate choice, not an oversight.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /repo
# Copy only what the resolver needs, so a source edit does not invalidate the
# install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./

# ⚠ EVERY WORKSPACE MANIFEST, NOT JUST THIS APP'S DEPENDENCIES. The build stage
# does `COPY . .`, which brings in the manifests this stage skipped. pnpm 11
# then sees a workspace larger than the one it installed, decides node_modules
# is out of date, and runs `pnpm install` on its own in the middle of the build
# step — which fails, with the error pointing at the build script rather than at
# the missing manifests. Listing them all keeps the deps layer cacheable and
# keeps that check quiet.
COPY apps/api/package.json apps/api/
COPY apps/console/package.json apps/console/
COPY apps/docs/package.json apps/docs/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/next/package.json packages/next/
COPY packages/node/package.json packages/node/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /repo
COPY . .
RUN pnpm --filter @i10/api build
# `pnpm deploy` flattens the workspace into a self-contained tree, which is
# what makes the runtime stage free of symlinks into packages/ that would not
# resolve once the repo is gone.
RUN pnpm --filter @i10/api deploy --prod --legacy /app

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production

# A writable HOME. Node tooling and npm-family CLIs write to $HOME at startup,
# and a non-root user without one exits EACCES at boot — a failure that reads
# like a permissions bug in the app.
# ⚠ THE UID IS PINNED, AND NUMERICALLY. `adduser -S` without -u picks the first
# free system UID, which is a property of the base image rather than of us — it
# moves when the base image does. More importantly kubelet cannot verify a
# NAMED user against `runAsNonRoot`: it has no way to resolve the name without
# reading the image's /etc/passwd, so it refuses to start the container with
# "image has non-numeric user". A number is the only form both sides agree on.
RUN addgroup -S -g 1001 i10 && adduser -S -u 1001 -G i10 -h /home/i10 i10 \
    && mkdir -p /home/i10 && chown -R i10:i10 /home/i10
ENV HOME=/home/i10

COPY --from=build --chown=i10:i10 /app /app
COPY --from=build --chown=i10:i10 /repo/apps/api/dist /app/dist

# ⚠ THE MIGRATIONS SHIP IN THE IMAGE. dist/migrate.js resolves them relative to
# itself, and the PreSync hook Job runs from this same image so the schema and
# the code that expects it are always the same artifact. Without this COPY the
# Job starts, finds an empty folder, reports "migrations applied", and changes
# nothing — a silent no-op is the worst possible outcome for a migration step.
COPY --from=build --chown=i10:i10 /repo/apps/api/drizzle /app/drizzle

USER 1001:1001
EXPOSE 3001

# Baked at build time and reported by /version. Not part of turbo's cache key —
# a promotion re-tags the same artifact, so one image serves both environments
# and learns which it is at runtime.
ARG GIT_SHA=dev
ARG BUILD_TIME
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME

CMD ["node", "dist/index.js"]
