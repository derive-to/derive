# Per-user Brandprint toggle

**Date:** 2026-07-24 · **Status:** approved · **Driver:** Customer.io feedback (users with their own design.md baked into their personal LLM want the org Brandprint out of their agents' context)

## Problem

Brandprint is workspace-level: `OrgSettings.brandprint` (a conventions collection + brand-profile artifact) is injected for every member's agents via the single resolver `resolveActorBrandprint` (`apps/api/src/lib/brandprint.ts:15`), which merges the workspace layer with the user's personal layer and feeds every consumer: MCP connect (`apps/api/src/mcp.ts:133`, keyed on the human behind the agent), rework (`apps/api/src/routes/rework.ts:171`), and context runs (`apps/api/src/routes/contexts.ts:263`, keyed on the context creator). There is no way for an individual to opt out: the workspace layer is always included (`resolveBrandprint`, `packages/core/src/brandprint.ts:22`, appends unconditionally).

## Change

A personal "use workspace Brandprint" switch, default on. When off, the workspace layer (its collection AND its profile) is dropped for that user everywhere the resolver feeds. A personal Brandprint collection, if set, still applies: the toggle governs the org's style only.

### 1. Storage: a field inside the existing personal-brandprint JSON

The personal layer is already a JSON string on the user row, written via `setUserProfile` / read via `getUserBrandprint` (`packages/core/src/ports.ts:930-936`) and parsed by `parseBrandprint` (`packages/core/src/brandprint.ts:34`) into `Brandprint { collectionId?, profileId? }`. Add an optional field to the core type:

- `Brandprint.useWorkspaceBrandprint?: boolean` — absent or `true` = on (today's behavior); `false` = off. Documented on the type as personal-layer-only (a workspace's own settings never carry it).

No schema migration, no Better-Auth field additions. A user with no personal collection can still store `{"useWorkspaceBrandprint": false}`.

### 2. Enforcement: one check in the pure resolver

`resolveBrandprint(ws, profile)` in `packages/core/src/brandprint.ts:22`: when `profile?.useWorkspaceBrandprint === false`, exclude `ws` entirely — `collectionIds` comes from the personal layer only and `profileId` is `undefined`. Every consumer (MCP resources + instructions, `derive://brandprint/profile`, rework, contexts) inherits the suppression with zero per-callsite changes, because they all flow through `resolveActorBrandprint`.

### 3. API surface: rides `/v1/me`

`GET/POST /v1/me` already carries `brandprint: PersonalBrandprintSchema` (`apps/api/src/routes/session.ts:189-232`; schema at `apps/api/src/schemas.ts:299`). Add `useWorkspaceBrandprint: z.boolean().optional()` to `PersonalBrandprintSchema` (and, since that schema is derived from `BrandprintSchema.omit`, ensure only the personal schema exposes it — the workspace-settings write path must NOT accept it). The POST handler persists it inside the same JSON blob; the existing collection-ownership validation is untouched. Regenerate `openapi.json` + web `api-types.ts`.

### 4. Rework guard: a distinct error for "disabled, not missing"

`POST /v1/artifacts/{shortId}/rework` 409s with `code: "needsBrandprint"` when nothing resolves (`rework.ts:182-183`), and the web menu item routes that to `/brandprint` setup (`rework-menu-item.tsx:65`). Split the empty case:

- Workspace has a Brandprint set, but the caller toggled it off and has no personal layer → `409` with `code: "brandprintDisabled"`, message "Brandprint is turned off in your settings. Turn it on to rework."
- Workspace genuinely has none (today's case) → existing `needsBrandprint` behavior, unchanged.

Web: `rework-menu-item.tsx` handles `brandprintDisabled` by showing that message as a small inline error/toast (matching how the component surfaces other failures) instead of navigating to `/brandprint`. If the caller's toggle is off but they DO have a personal collection, rework proceeds on the personal brief alone: no error.

### 5. Web UI: a switch in the Brandprint page's personal section

`apps/web/src/pages/brandprint/brandprint-section.tsx` (the personal Brandprint surface). Add a labeled switch, "Use workspace Brandprint", with a one-line explanation (e.g. "Off: your agents skip this workspace's style and profile; your personal conventions still apply."). Rendered only when the workspace actually has a Brandprint configured; persists through the existing `/v1/me` save path; reflects server state on load. Default on. `data-testid` required (`lint:testids`). No em dashes in UI copy.

## Documented caveats (not solved here)

- Global per-user, not per-workspace: the personal JSON is one blob per user. A per-workspace toggle needs new storage (`MembershipRecord` has no settings column); deferred until someone asks.
- Context runs resolve by the context CREATOR (`contexts.ts:263`), so a creator's opt-out applies to that context's sessions regardless of who is reading. State this in the resolver's doc comment.

## Testing

- **Core** (`packages/core/test/brandprint.test.ts`): resolveBrandprint truth table — toggle absent/true keeps today's merge; `false` drops ws collection + profile while keeping personal collection; `false` with no personal layer resolves empty; parseBrandprint round-trips the new field.
- **API** (`apps/api/test/`): POST /v1/me persists the toggle and GET returns it; workspace-settings route rejects/ignores `useWorkspaceBrandprint`; rework with toggle off + workspace brandprint set + no personal layer → 409 `brandprintDisabled`; toggle off + personal collection → rework proceeds (201/posted); no workspace brandprint at all → 409 `needsBrandprint` unchanged; MCP connect for a user with the toggle off exposes no `derive://brandprint/*` workspace resources (follow the existing MCP brandprint test pattern).
- **Web**: unit-test any pure state helper added; the switch carries a testid; typecheck + testids/tokens lints green.
