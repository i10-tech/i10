# syntax=docker/dockerfile:1.7
# ⚠ THE TAG IS PINNED TO THE EXACT VERSION, not `1-alpine` — see
# apps/api/Dockerfile. `.bun-version`, `packageManager`, ci.yml's BUN_VERSION
# and every base image here move together.
#
# ⚠ AND 1.4.2 IS A FLOOR, NOT JUST A PIN, FOR THIS IMAGE IN PARTICULAR. Next's
# standalone server.js does not run on bun 1.3.x: it boots, prints "Ready",
# answers the connection, and then fails every render with "Expected CommonJS
# module to have a function wrapper" while loading
# next/dist/compiled/next-server/app-page-turbo.runtime.prod.js. That is
# oven-sh/bun#25609, fixed in 1.3.14. `next dev` and `next start` were fine
# throughout, and a --webpack build failed identically, so downgrading the
# bundler is not a way out of it. Do not move this base image backwards.
FROM oven/bun:1.4.2-alpine AS base

FROM base AS deps
WORKDIR /repo
COPY bun.lock bunfig.toml package.json ./
COPY apps/auth/package.json apps/auth/
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
RUN bunx turbo run build --filter=@i10/auth

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000

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

# The three pieces `output: standalone` splits a build into. static/ and
# public/ are NOT inside the standalone tree — copying only server.js gives a
# site that renders with every stylesheet and image 404ing.
#
# ⚠ standalone STILL CARRIES A node_modules, UNLIKE THE API IMAGE. Next traces
# the server's imports and copies them in; that tree is Next's output, not a
# package manager's, so there is nothing here to flatten or prune and nothing
# that depends on how the workspace was linked.
COPY --from=build --chown=i10:i10 /repo/apps/auth/.next/standalone ./
COPY --from=build --chown=i10:i10 /repo/apps/auth/.next/static ./apps/auth/.next/static
COPY --from=build --chown=i10:i10 /repo/apps/auth/public ./apps/auth/public

USER 1001:1001
EXPOSE 3000

ARG GIT_SHA=dev
ARG BUILD_TIME
ENV GIT_SHA=$GIT_SHA BUILD_TIME=$BUILD_TIME

# Next's own server.js, run by bun. See the base image note above for the
# version floor this depends on.
CMD ["bun", "apps/auth/server.js"]
