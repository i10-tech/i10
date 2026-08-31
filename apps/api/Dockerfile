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
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/typescript-config/package.json packages/typescript-config/
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
RUN addgroup -S i10 && adduser -S -G i10 -h /home/i10 i10 \
    && mkdir -p /home/i10 && chown -R i10:i10 /home/i10
ENV HOME=/home/i10

COPY --from=build --chown=i10:i10 /app /app
COPY --from=build --chown=i10:i10 /repo/apps/api/dist /app/dist

USER i10
EXPOSE 3001

# Baked at build time and reported by /version. Not part of turbo's cache key —
# a promotion re-tags the same artifact, so one image serves both environments
# and learns which it is at runtime.
ARG GIT_SHA=dev
ARG BUILD_TIME
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME

CMD ["node", "dist/index.js"]
