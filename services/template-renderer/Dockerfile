# syntax=docker/dockerfile:1.7

# The template renderer on celld (https://celld.dev): a STOPGAP for Cloudflare's
# Dynamic Workers until the account is on Workers Paid (decided 2026-09-30, see
# docs/decisions/templates.md). The same code deploys to Cloudflare from
# wrangler.jsonc; this image runs it in the cluster instead.
#
# Built from the REPO ROOT, like the bun apps, because it installs from the
# workspace lockfile.

# ⚠ THE BUN TAG MOVES WITH THE OTHER FOUR PLACES THAT HOLD IT - see
# apps/api/Dockerfile.
FROM oven/bun:1.4.2-alpine AS build
WORKDIR /repo
COPY bun.lock bunfig.toml package.json ./
# Only the workspaces this build needs, and every workspace they depend on;
# .github/scripts/check-dockerfile-workspaces.mjs checks the closure.
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/templates/package.json packages/templates/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY services/template-renderer/package.json services/template-renderer/
ENV BUN_INSTALL_CACHE_DIR=/bun-cache
RUN --mount=type=cache,id=bun,target=/bun-cache \
    bun install --frozen-lockfile

COPY packages/typescript-config packages/typescript-config
COPY packages/templates packages/templates
COPY services/template-renderer services/template-renderer
RUN cd packages/templates && bun run build
RUN cd services/template-renderer && bun run build:celld

# ⚠ PINNED TO A RELEASE. celld is pre-1.0 and releases about weekly; a floating
# tag would change the sandbox under us without a commit saying so.
FROM ghcr.io/denoland/celld:v0.6.0

# celld dev writes its state under the project (/app/.celld/dev) and the
# entrypoint writes /app/.dev.vars, so the directory is the app user's.
RUN groupadd --gid 1001 i10 && useradd --uid 1001 --gid 1001 --create-home i10 \
    && mkdir /app && chown i10:i10 /app
WORKDIR /app
COPY --from=build --chown=i10:i10 /repo/services/template-renderer/celld.jsonc ./
COPY --from=build --chown=i10:i10 /repo/services/template-renderer/dist/worker.js ./dist/
COPY --chown=i10:i10 services/template-renderer/entrypoint.sh /usr/local/bin/entrypoint.sh
USER 1001
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
