# Library card preview thumbnails

Status: design · 2026-07-05 · branch `feat/preview-cards` (stacked on `feat/artifact-previews`)

## Problem

Every library card renders a **live, scaled-down `<iframe>`** of the artifact (`apps/web/src/components/shared/thumb.tsx`, pointed at `/raw/:id/v/:n/index.html` at `scale-[0.4]`). It works only in-app, costs a full page fetch + render per card, and can't reuse the screenshots the previews feature now produces. Now that a version can have a rendered PNG (`preview_status="ready"` + `preview_key`, served by `/v1/og/:ref`), cards should show that static image and keep the iframe only as a fallback.

## Constraint the codebase imposes

The library list endpoint (`apps/api/src/routes/artifacts.ts`) returns `toJson(baseUrl, a, [])` — the denormalized **artifact** row with an empty versions array. `preview_status`/`preview_key` live on the **version** row, so the list response currently has no way to know whether a screenshot exists. The card must be told by the server.

## Goals

1. A card shows the static PNG when the current version has a ready preview; the live iframe otherwise (and if the image fails to load).
2. No N+1: preview availability for a page of artifacts is resolved in one query.
3. Preview data stays single-sourced on the version row (no schema change, no denormalization write-path).
4. Visibility is preserved: a card only shows a PNG the viewer is authorized to see (already true — `/v1/og` gates via `readable()`).

## Non-goals

- A separate card-sized capture. Reuse the existing 1200×630 OG PNG (object-cover in the 16:10 card). One render, not two.
- Changing how previews are generated or `/v1/og` behaves.

## Architecture

### Server (Task 1)

- Add a batched `MetaStore` method that, for a set of artifact ids, reports which have a **ready preview on their current version**. Follow the existing batched-read pattern (`viewCounts`, `tagsForArtifacts`, `commentSignals`): one query joining `version` on `(artifact_id, n = artifact.current_version)` filtered to `preview_status = 'ready'`. Signature:
  `previewReady(artifactIds: string[]): Promise<Record<string, boolean>>`
  Implement in both stores (`repos.ts` sqlite/d1, `pg.ts`). Add to the `MetaStore` interface in `packages/core/src/ports.ts`. No schema change; no parity impact (no new table/column).
- The list endpoint (`artifacts.ts`) calls it for the page and adds `has_preview: boolean` to each artifact in the JSON (alongside `views`, `tags`, `favorite`). Also add `has_preview` to the profile work-list endpoint if it uses the same card (verify; include only if it renders `Thumb`).
- Extend the web `Artifact` type (`apps/web/src/api.ts`) with `has_preview?: boolean`.

### Web (Task 2)

- `Thumb` gains `hasPreview?: boolean` and needs the artifact `ref` (it already gets `id` = short_id; the PNG URL is `${API_BASE}/v1/og/${id}`). When `hasPreview`, render `<img src={ogUrl} className="...object-cover..." loading="lazy" onError={fallback}>`; on error or when `!hasPreview`, render the existing iframe. Keep the type/version placard and the aspect-[16/10] frame unchanged.
- `artifact-card.tsx` passes `hasPreview={a.has_preview}`.
- Keep it one component with two render paths; don't split files.

## Data flow

list request → `listArtifacts` (artifact rows) → `previewReady(ids)` (one query) → JSON with `has_preview` → card → `Thumb` renders `<img /v1/og/:ref>` (authed viewer authorized by `readable()`) or iframe fallback.

## Testing

- Server: `previewReady` returns true only when the CURRENT version is `ready` (not a superseded version, not pending/failed); batched over multiple ids; empty input → empty. List endpoint includes `has_preview` true/false correctly. (db test + api route test.)
- Web: `Thumb` renders `<img>` when `hasPreview`, iframe when not, and falls back to iframe on img `onError` (component test in the web app's vitest, matching existing web test patterns).

## Rollout

Independent PR targeting `feat/artifact-previews`. Harmless before the base merges (cards just fall back to the iframe when `has_preview` is false, which is the case until screenshots exist).
