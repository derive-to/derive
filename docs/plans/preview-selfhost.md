# Self-host preview rendering (Playwright)

Status: design · 2026-07-05 · branch `feat/preview-selfhost` (stacked on `feat/artifact-previews`)

## Problem

Preview screenshots render only on the hosted Cloudflare tier (the `PreviewRenderer` Durable Object + Cloudflare Browser Rendering). Self-hosted Node deployments have no renderer: `renderPreviews` is unset, so no jobs are enqueued and no previews are ever produced. Self-hosters should be able to turn previews on.

## What already exists (base branch)

- `apps/api/src/previews.ts` — the runtime-neutral worker: `Renderer` port, `runRenderTick(deps)`, `startPreviewWorker(deps, intervalMs)`, and `RenderTickDeps { meta, blobs, renderer, baseUrl, sandboxOrigin?, secret }`. `runRenderTick` already mints the `pv` token and builds the `/raw?pv=` URL, so a renderer only implements `screenshot(url, opts)`.
- The Cloudflare adapter (`preview-cf.ts`) is the reference shape.
- `AppDeps.renderPreviews` / `pokePreviews` already gate enqueue + wake the worker.

## Goal

A Node/Playwright renderer, wired in `node.ts`, opt-in via env, with Chromium bundled in the Docker image so it works out of the box.

## Non-goals

- Changing the render pipeline, queue, or token (all reused unchanged).
- Enabling previews by default on self-host (Chromium is heavy; opt-in only).
- A remote-browser (`DERIVE_BROWSER_WS`) option — can be added later behind the same port.

## Architecture

### The adapter (Task 1)

`apps/api/src/preview-node.ts` (Node-only; imported ONLY by `node.ts`, never by the edge build): `playwrightRenderer()` returns a `Renderer` whose `screenshot(url, opts)` launches Chromium via Playwright, renders in an isolated context, and returns PNG bytes:

- Launch a shared `chromium` browser lazily on first use (or per call — start per-call for correctness, matching `preview-cf.ts` which launches per screenshot; a warm singleton is a later optimization). Use an isolated `browser.newContext()` with no shared state, `setViewportSize({ width, height })`, `page.goto(url, { waitUntil: "networkidle", timeout: opts.timeoutMs })`, `page.screenshot({ type: "png", fullPage: !!opts.fullPage })`, and close the context/browser in `finally`. Constrain the context (no persistent storage).
- `playwright` is added to `apps/api` dependencies (Chromium binary provided by the image; see Task 2).

### Node wiring (Task 1)

In `apps/api/src/node.ts`, mirror the webhook-worker wiring:

- Add a config flag: `config.ts` gains `previews: boolean` from `DERIVE_PREVIEWS === "true"` (default false). Follow the existing optional-flag pattern (`analytics`, `rateLimit`).
- When `cfg.previews`: build `const previewWorker = startPreviewWorker({ meta, blobs, renderer: playwrightRenderer(), baseUrl: cfg.baseUrl, sandboxOrigin: cfg.sandboxOrigin, secret: authSecret })`, and pass `renderPreviews: true` + `pokePreviews: previewWorker.poke` into `createApp`. When off, leave `renderPreviews` unset (today's behavior) and don't start the worker or import Playwright at module load (import it lazily inside the enabled branch, or top-level is fine since node.ts is Node-only).
- Add `previewWorker.stop()` to the shutdown sequence alongside `webhookWorker.stop()`.

### Docker (Task 2)

`deploy/Dockerfile`: after installing node deps, run `pnpm --filter @derive/api exec playwright install --with-deps chromium` (or the equivalent for the image's base) so the Chromium binary + its OS libs are present. Keep this in the image that self-hosters run. Document in `.env.example` / DEPLOY.md that previews are enabled with `DERIVE_PREVIEWS=true` and require the bundled Chromium (present in the Docker image; non-Docker Node hosts run `playwright install chromium` once).

## Security & isolation

Same model as hosted: the renderer loads gated `/raw` via the short-lived `pv` token that `runRenderTick` mints (the adapter does nothing token-related). Render untrusted artifact HTML in an isolated, ephemeral browser context with no shared cookies/storage; the container's network egress is the operator's to constrain.

## Testing

- The real browser is not unit-tested (mirrors how the CF adapter is deploy/smoke-verified). Unit-test the WIRING: with `DERIVE_PREVIEWS=true`, `node.ts`'s app-construction path sets `renderPreviews: true` and starts a worker; with it unset, it does not. Test with a fake renderer / by asserting the config + deps, not by launching Chromium.
- `config.ts`: `DERIVE_PREVIEWS=true` → `previews: true`; unset/other → false.
- A local smoke test (documented, not CI): `DERIVE_PREVIEWS=true` self-host, publish an HTML artifact, confirm `/v1/og/:ref` returns a PNG.

## Rollout

Independent PR targeting `feat/artifact-previews`. Off by default, so it changes nothing for existing self-host deployments until `DERIVE_PREVIEWS=true` is set.
