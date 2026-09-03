# Autumn's dashboard SPA.
#
# ⚠ OURS BECAUSE UPSTREAM HAS NONE. Their `docker/Dockerfile` builds the server,
# workers, cron and leaf; the dashboard under `vite/` is built and hosted by
# their own deploy platform, so self-hosting it means building it ourselves.
# Built from the same pinned upstream checkout as the server image, so the two
# cannot drift into speaking different API versions.
#
# ⚠ THE URLS ARE BUILD ARGUMENTS, NOT ENVIRONMENT VARIABLES. Vite substitutes
# `import.meta.env.VITE_*` at build time and drops the rest; setting them on the
# running container does nothing, silently, and the SPA then calls
# `http://localhost:8080` from the customer's browser.
FROM oven/bun:1.3.14 AS build
WORKDIR /app

COPY . .

ARG VITE_BACKEND_URL
ARG VITE_FRONTEND_URL
ENV VITE_BACKEND_URL=${VITE_BACKEND_URL}
ENV VITE_FRONTEND_URL=${VITE_FRONTEND_URL}

# `--ignore-scripts` for the same reason their Dockerfile uses it: postinstall
# hooks in a workspace this size are a supply-chain surface we gain nothing from.
RUN bun install --ignore-scripts --frozen-lockfile
RUN bun -F @autumn/vite build:bun

FROM oven/bun:1.3.14
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/vite/dist ./dist

# `serve -s` is single-page mode: every unknown path returns index.html, which
# is what a client-side router needs. Without `-s` a refresh on /customers is a
# 404 from the static server rather than a route.
EXPOSE 3000
CMD ["bunx", "--bun", "serve", "-s", "dist", "-l", "3000"]
