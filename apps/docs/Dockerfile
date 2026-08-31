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
FROM nginx:1.31-alpine AS runtime
COPY --from=build /repo/apps/docs/dist /usr/share/nginx/html
COPY apps/docs/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
