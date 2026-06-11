# Dock — one container: API + viewer (+ embedded web UI once apps/web ships).
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["pnpm", "--filter", "@dock/api", "start"]
