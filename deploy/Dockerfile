# Dock API container — serves the publish API, comment loop, and sandboxed
# artifact viewer. The web SPA deploys separately to a CDN (see DEPLOY.md).
FROM node:22-slim AS base
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY . .
# better-sqlite3 v11 ships prebuilt binaries; pg is pure JS — no compiler needed.
RUN pnpm install --frozen-lockfile --prod=false

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
# Only used in the SQLite fallback; ignored when DATABASE_URL + OBJECT_STORE_URL are set.
VOLUME /data
EXPOSE 8080
CMD ["pnpm", "--filter", "@dock/api", "start"]
