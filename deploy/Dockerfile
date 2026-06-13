# Dock — one self-contained container: the publish API, comment + review loops,
# the sandboxed artifact viewer, AND the web app, all on one origin. Point a
# domain at it and you have a working Dock. (Scale-out split: see DEPLOY.md.)
FROM node:22-slim AS base
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY . .
# better-sqlite3 v11 ships prebuilt binaries; pg is pure JS — no compiler needed.
RUN pnpm install --frozen-lockfile --prod=false

# Build the SPA into apps/web/dist/client. VITE_DOCK_API is intentionally unset
# so the bundle calls the API same-origin (no CORS, no cross-site cookies). The
# Node entry auto-detects this build and serves it. ipv4first keeps TanStack
# Start's prerender loopback (server bind vs fetch) on the same address in the
# slim image, which otherwise splits ::1 / 127.0.0.1 and ECONNREFUSEs.
RUN NODE_OPTIONS=--dns-result-order=ipv4first pnpm --filter @dock/web build

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
# Only used in the SQLite fallback; ignored when DATABASE_URL + OBJECT_STORE_URL are set.
VOLUME /data
EXPOSE 8080
CMD ["pnpm", "--filter", "@dock/api", "start"]
