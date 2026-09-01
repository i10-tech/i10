# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/docs/package.json apps/docs/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/typescript-config/package.json packages/typescript-config/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
# Pagefind builds its search index as a POSTBUILD step over the emitted HTML,
# so it must run here and not at serve time — the runtime stage has no Node.
RUN pnpm --filter @i10/docs build

# A static site needs a static server. No Node in the runtime stage means no
# Node CVEs to patch on a container that only reads files off disk.
#
# ⚠ CADDY, NOT nginx, AND THE REASON IS A DEFAULT RATHER THAN A PREFERENCE.
# nginx builds directory-index redirects as ABSOLUTE urls from its own listen
# port and scheme, so behind a TLS-terminating proxy /api 301'd to
# `http://docs.i10.tech:8080/api/` — a port nothing exposes. The fix there is a
# `absolute_redirect off;` incantation you have to know about. Caddy resolves
# routes internally and needs no such knowledge.
#
# ⚠ THE XDG VARIABLES ARE NOT OPTIONAL. Caddy writes its data and config
# directories on startup, defaulting to $HOME — which for a numeric UID with no
# passwd entry does not exist. It fails at boot with a permission error that
# names a path nobody put in any config. Pointing both at /tmp keeps the root
# filesystem untouched.
FROM caddy:2-alpine AS runtime

# ⚠ STRIP THE BINARY'S FILE CAPABILITIES OR IT WILL NOT EXECUTE AT ALL.
#
# The upstream image runs `setcap cap_net_bind_service=+ep /usr/bin/caddy` so it
# can bind :80 as a non-root user. We bind 8080 and do not need it — and worse,
# executing a file that CARRIES file capabilities, as a non-root user, in a
# container whose bounding set was emptied by `capabilities: {drop: ["ALL"]}`,
# fails with `exec /usr/bin/caddy: operation not permitted`. The container dies
# before Caddy prints a line, so there is nothing in the log but that sentence.
#
# It does not reproduce under a plain `docker run`, which keeps the default
# capability set — only under the Deployment's securityContext. Removing the
# capabilities from the file is what makes the two environments agree.
RUN apk add --no-cache libcap \
    && setcap -r /usr/bin/caddy \
    && apk del libcap

ENV XDG_DATA_HOME=/tmp XDG_CONFIG_HOME=/tmp
COPY --from=build /repo/apps/docs/dist /srv
COPY apps/docs/Caddyfile /etc/caddy/Caddyfile
# Matches runAsUser/runAsGroup in infra/k8s/i10/workloads/docs.yaml. Numeric,
# because kubelet refuses a named USER under `runAsNonRoot: true`.
USER 1001:1001
EXPOSE 8080
