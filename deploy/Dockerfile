# syntax=docker/dockerfile:1.7
# Derive Lite: one non-root image containing the API, SPA, SQLite/local-blob
# storage, and optional Playwright preview renderer.
FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS build
ENV CI=true
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY patches ./patches
RUN pnpm fetch
COPY . .
# A CI canary creates these paths immediately before the build. If a future
# ignore-file edit uploads either one, fail before dependency or source build.
RUN test ! -e deploy/.env && test ! -e deploy/backups/build-context-canary
RUN pnpm install --offline --frozen-lockfile
RUN NODE_OPTIONS=--dns-result-order=ipv4first pnpm --filter @derive/web build
# A production-only, portable dependency graph. The legacy deploy mode is
# intentional until this workspace opts into pnpm's injected-workspace layout.
RUN pnpm --filter @derive/api deploy --legacy --prod /runtime/apps/api && \
    mkdir -p /runtime/apps/web/dist && \
    cp -R /src/apps/web/dist/client /runtime/apps/web/dist/client

FROM node:26-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e AS runtime
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Derive" \
      org.opencontainers.image.description="Self-hosted Derive artifact workspace" \
      org.opencontainers.image.source="https://github.com/derive-to/derive" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="FSL-1.1-ALv2"
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DERIVE_BUILD_SHA=${REVISION}
COPY --from=build --chown=node:node /runtime /app
WORKDIR /app/apps/api
# Only the smaller headless shell is needed. Playwright installs the matching
# browser and Debian runtime libraries; app code and package managers stay out
# of the final image except for the production graph copied above.
RUN node node_modules/playwright/cli.js install --with-deps --only-shell chromium && \
    mkdir -p /data && \
    chown -R node:node /data /ms-playwright
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "--import", "tsx", "src/server-cli.ts"]
CMD ["serve"]
