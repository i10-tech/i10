# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/ui/package.json packages/ui/
COPY packages/node/package.json packages/node/
COPY packages/next/package.json packages/next/
COPY packages/contracts/package.json packages/contracts/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/typescript-config/package.json packages/typescript-config/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /repo
COPY . .
ARG GIT_SHA=dev
ARG BUILD_TIME
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @i10/web build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3002

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
COPY --from=build --chown=i10:i10 /repo/apps/web/.next/standalone ./
COPY --from=build --chown=i10:i10 /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=i10:i10 /repo/apps/web/public ./apps/web/public

USER 1001:1001
EXPOSE 3002

ARG GIT_SHA=dev
ARG BUILD_TIME
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME

CMD ["node", "apps/web/server.js"]
