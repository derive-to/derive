# Artifact preview images (screenshots)

Status: design, awaiting review · 2026-07-05 · branch `feat/artifact-previews`

## Problem

Derive renders artifacts well, but it has no *portable* preview of one. Two gaps
follow from that:

- **Share links unfurl as a generic card.** `/v1/og/:ref` serves an SVG built from
  metadata (title + version/comment counts) on the brand background. Paste a Derive
  link into Slack / Discord / X / Notion and the unfurl shows chrome, not the work.
- **Library cards fake it with a live iframe.** `components/shared/thumb.tsx` mounts
  a sandboxed `<iframe>` at `/raw/:id/v/:n/index.html` scaled to 0.4. It only works
  inside the app, in a browser, and costs a full page fetch + render per card.

Both want the same missing primitive: a real raster image (PNG) of the rendered
artifact, generated once and reused anywhere a live browser can't run — unfurls,
emails, and (later) the library cards themselves.

## Constraint that shapes everything

Producing a screenshot of arbitrary artifact HTML/CSS/JS requires a real browser.
The hosted product (`derive.to`) runs on **Cloudflare Workers**, which cannot run a
bundled headless browser (Node-only; the Workers build forbids Node modules, see
`ARCHITECTURE.md`). Self-host Node containers *can* run one. So the renderer must be
a swappable adapter chosen per runtime — exactly how `BlobStore` (fs vs S3/R2) and
`MetaStore` (sqlite/pg/d1) are already selected. We follow that grain.

## Goals (this PR — the focused first slice)

1. Real screenshots on the hosted tier, generated in the background, stored as blobs.
2. `/v1/og/:ref` serves the screenshot when ready; **falls back to today's SVG card**
   while a version's preview is pending or failed. Nothing ever looks broken.
3. Reliable generation: crash-safe, retried, no double-render across instances.
4. Feature is **off unless configured**; the app behaves exactly as today when off.

## Non-goals (deliberate fast-follows, not this PR)

- **Library-card swap** (`Thumb` → static PNG with the iframe as fallback). Separate PR.
- **Self-host Playwright adapter.** The port is designed for it and it's stubbed, but
  the hosted Cloudflare adapter is the only one wired live here.
- **External third-party screenshot API.** Rejected: per-render cost, and it would send
  private artifact bytes off your infrastructure, against Derive's data-ownership stance.

## Architecture

```
publish/approve ──emits──▶ version.published
        │
        ▼
  enqueue render job (outbox row)          [reuses the webhook-outbox pattern]
        │
        ▼
  render worker  ── Node: interval loop │ Workers: Durable Object alarm
        │
        ▼
  Renderer.screenshot(rawUrl, opts) ──▶ PNG bytes   [adapter: CF Browser Rendering | Playwright | off]
        │
        ▼
  BlobStore.put(png) ─▶ sha256 key ; version.preview_key = key, preview_status = "ready"
        │
        ▼
  /v1/og/:ref serves the PNG when ready, else the SVG card (unchanged)
```

### 1. The `Renderer` port (`packages/core`)

Runtime-agnostic, Node-free (core must compile for Workers):

```ts
export interface Renderer {
  // Render the page at `url` to a PNG. `url` is an internal, time-boxed URL that
  // resolves to the artifact's /raw view (including gated artifacts — see Security).
  screenshot(url: string, opts: ScreenshotOpts): Promise<Uint8Array>
}
export interface ScreenshotOpts {
  width: number          // viewport width  (capture at target size; no raster resize dep)
  height: number         // viewport height (the OG frame is 1200x630)
  fullPage?: boolean     // default false — capture the above-the-fold frame
  timeoutMs: number      // hard cap; a hung page must not wedge the worker
}
```

Core owns only the interface. Adapters live outside core so they can pull runtime deps.

### 2. Adapters (selected by env, like the storage/db adapters)

- **`cf-browser` (Workers / hosted):** `@cloudflare/puppeteer` against a `BROWSER`
  binding (Cloudflare Browser Rendering / "Browser Run"). No browser ships in the
  isolate; the Worker drives a remote Chromium. Wired in `worker.ts` alongside the
  existing `WEBHOOK_OUTBOX` / `ROOMS` bindings; declared in `wrangler.toml`.
- **`playwright` (Node / self-host):** stubbed interface only in this PR; a follow-up
  wires Playwright + Chromium in `node.ts`.
- **off (default):** no renderer; enqueue is skipped; `/v1/og` serves the SVG card.

Selection mirrors `node.ts` (`DATABASE_URL ⇒ pg`) and `worker.ts` binding checks. The
adapter never imported into `packages/core`; only `apps/api` wires a concrete one.

### 3. Durable render queue (reuse, don't reinvent)

Screenshots are slow (seconds) and can fail (hung page, missing asset), so best-effort
`background()`/`waitUntil` would silently drop previews. Instead reuse the proven
webhook-outbox machinery (`webhooks.ts`): claim-with-lease, exponential backoff,
capped attempts, dead-letter. Two options, decided in the plan:

- **(preferred) A dedicated `render_job` table + a sibling worker** that mirrors the
  outbox's claim/lease/retry semantics and drivers (Node interval loop; a
  `PreviewRenderer` Durable Object alarm on Workers, exported from `worker.ts` exactly
  like `WebhookOutbox`). Keeps delivery semantics and render semantics separate.
- (alternative) A new `DeliveryKind` on the existing outbox. Less new code, but
  overloads a table whose meaning is "notify a channel," not "produce an asset."

Trigger seam: enqueue right where events already fan out — the `notify(artifact,
"version.published", …)` calls in `routes/artifacts.ts` and `routes/proposals.ts`
(approval), via a small enqueue helper next to `enqueueForEvent` in `context.ts`.
Only the **current** version is rendered (previews of superseded versions aren't shown).

### 4. Storage + data model

PNG bytes go to `BlobStore.put()` (content-addressed sha256, same as artifact content —
identical renders dedupe for free). The version row learns where its preview lives:

New nullable columns on the `version` table:

| column | type | meaning |
|---|---|---|
| `preview_key` | text, null | blob key of the PNG; null until rendered |
| `preview_status` | text, null | `pending` \| `ready` \| `failed` (null = never queued) |
| `preview_error` | text, null | short reason when `failed` (for the settings/debug view) |

Schema changes land in lockstep across the three stores (the parity guards in
`packages/db/src/parity.ts` enforce this): `packages/db/src/schema.ts` (drizzle
sqlite/d1), `deploy/d1-schema.sql`, and the Postgres schema (`scripts/` + `test:pg`).
`VersionRecord` in `packages/core/src/ports.ts` gains the three fields; `check-schema.mjs`
must stay green.

### 5. Consumer (`/v1/og/:ref`)

Change is small and additive. Today it returns `ogCardSvg(...)`. New behavior:

1. Resolve the artifact (unchanged `readable()` visibility gate).
2. If the current version has `preview_status = "ready"`, fetch `preview_key` from
   blobs and return the PNG (`image/png`).
3. Otherwise return the existing SVG card (pending, failed, gated, or feature-off).

Caching stays as-is (`max-age=86400, stale-while-revalidate=604800`); when a preview
lands after the fact, stale-while-revalidate refreshes the unfurl within the window.
`oembed`'s `thumbnail_url` already points at `/v1/og/:ref`, so it inherits the upgrade.

## Security & privacy

- **Gated artifacts.** `/raw` is authz-gated, so the renderer needs authorized access
  to private/link/org/password artifacts. Use a short-lived, single-use signed internal
  URL (or the existing `DERIVE_TOKEN` trusted path) that resolves to the `/raw` view for
  exactly one version, then expires. No credentials embedded in the artifact.
- **Untrusted content.** Artifacts run arbitrary scripts. Render each in an isolated
  browser context with no shared cookies/storage and constrained egress. Cloudflare
  Browser Rendering is already an isolated remote fleet; the future Playwright adapter
  must replicate the isolation locally.
- **No private bytes leave the trust boundary.** Hosted → Cloudflare (same vendor as
  the app). Self-host → the operator's own machine. Never a third party.

## Cost (hosted)

Cloudflare Browser Rendering needs the Workers Paid plan ($5/mo) and bills per
browser-minute + per concurrent browser (free allowance covers light usage; free plan
capped at 10 browser-min/day; a session idles out at 60s, extendable via `keep_alive`).
Controls: render only the current version, dedupe identical renders via content
addressing, cap render concurrency in the worker, and skip re-rendering when
`preview_status = "ready"` for the current `blob_key`.

## Runtime matrix

| runtime | renderer | queue driver | this PR |
|---|---|---|---|
| Hosted (Workers + Postgres + R2) | `cf-browser` | `PreviewRenderer` DO alarm | ✅ live |
| Self-host (Node container) | `playwright` | Node interval loop | port ready, adapter stubbed |
| Workers build integrity | — | — | ✅ no Node dep leaks into the edge build |

## Testing

- Core: `Renderer` port + a fake renderer; enqueue-on-`version.published`; the OG
  route's ready/pending/failed/gated branch selection (fake blobs + meta).
- DB: parity guards + `check-schema.mjs` green across sqlite/d1/pg for the new columns.
- The live `cf-browser` adapter is validated against a real binding in a preview
  deploy, not in unit tests (mirrors how `pg`/webhook DOs are exercised).

## Phased delivery

- **PR1 (this):** port + `cf-browser` adapter + render queue + version columns + OG
  consumer + feature flag + graceful fallback.
- **PR2:** library `Thumb` swaps to the static PNG (iframe as the not-ready fallback).
- **PR3:** self-host `playwright` adapter wired in `node.ts`.

## Open questions for review

1. Dedicated `render_job` table (preferred) vs. a new `DeliveryKind` on the outbox?
2. Capture geometry: OG-native `1200x630` only, or also a 16:10 capture for the future
   card so we render once and crop? (Rendering per-purpose is simplest; revisit in PR2.)
3. Signed internal URL vs. `DERIVE_TOKEN` for the renderer's access to gated `/raw`.
