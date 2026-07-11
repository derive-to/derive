# Brandprint Phase 2: The Brand Profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user's own agent assembles one beautiful, machine-readable HTML brand profile from uploaded sources, files it as a proposal on a placeholder artifact Derive created at intake, and a reveal-plus-Approve on `/brandprint` makes it what every agent reads first.

**Architecture:** Everything composes shipped parts: the intake hook publishes a placeholder artifact and stores `profileId` in the existing Brandprint JSON pointer; two static MCP resources (`reference`, `template`) carry all generation intelligence; the agent's `publish for_review:true` lands on the existing proposals pipeline; the page states iframe the existing `/raw/:id/p/:proposalId` and `/raw/:id/v/:version` routes and approve via the existing route. `BrandprintTheme` is deleted (zero consumers, superseded by the profile's embedded tokens).

**Tech Stack:** Hono + zod-openapi (API), MCP SDK (`registerResource`), React + TanStack Query/Router (web), vitest.

## Global Constraints

- Spec: `docs/plans/brandprint.md` section "The brand profile (next, Phase 2)". Follow its copy verbatim where quoted.
- Base: `main` @ `156ba68`. Branch: `feat/brandprint-profile`. Commit author Connor `<cpellan561@gmail.com>`, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `pnpm` is not on PATH here: run everything via `corepack pnpm`; commit with `--no-verify` ONLY after running the gauntlet manually (biome check + every `lint:*` script except `lint:deadcode`/`lint:bundle`; `lint:api-types` fails on spawnSync ENOENT in this environment — run `corepack pnpm exec tsc` typechecks instead and regenerate api types with the check script's generator if route schemas change).
- Derive never runs inference and never solicits: MCP instructions stay factual and user-conditioned ("If the user asks…").
- Personal scope gets NO profile treatment: no placeholder, no `profileId`, no hand-off UI.
- `profileId` stores the artifact **short_id** (not internal id) — the brief, the MCP lookup, and the web all speak short_id.
- Profile is "live" when its artifact's `current_version >= 2` (version 1 is always the placeholder stub).
- Tests: extend the files that already cover the area (`packages/core/test/brandprint.test.ts`, `apps/api/test/mcp.test.ts`, `apps/api/test/integrations-settings.test.ts`, `apps/api/test/profiles.test.ts`). Match existing test style.
- After route/schema changes, regenerate the web client types the way `scripts/check-api-types.mjs` does, so `apps/web/src/api-types.ts` matches.

---

### Task 1: Branch + carry the current spec

The spec updates live on the unmerged `docs/brandprint-status` branch; the feature branch must carry them so the PR is self-contained (that docs branch then closes unmerged).

**Files:**
- Modify: `docs/plans/brandprint.md` (replace with the version from `origin/docs/brandprint-status`)

- [ ] **Step 1: Branch off main**

```bash
git checkout main && git pull --ff-only
git checkout -b feat/brandprint-profile
```

- [ ] **Step 2: Bring the spec current and commit**

```bash
git checkout origin/docs/brandprint-status -- docs/plans/brandprint.md
git add docs/plans/brandprint.md
git commit --no-verify -m "docs(brandprint): sync spec — Phase 2 is the brand profile"
```

### Task 2: Core — `profileId`, theme removal, state-aware instructions

**Files:**
- Modify: `packages/core/src/ports.ts:1604-1632` (Brandprint + BrandprintTheme types)
- Modify: `packages/core/src/brandprint.ts` (resolve, instructions; delete mergeTheme)
- Test: `packages/core/test/brandprint.test.ts`

**Interfaces:**
- Produces: `Brandprint = { collectionId?: string; profileId?: string }`; `ResolvedBrandprint = { collectionIds: string[]; profileId?: string }`; `resolveBrandprint(ws?, profile?)` (personal `profileId` ignored by design); `brandprintInstructions(docCount: number, profile?: { state: "pending" | "live"; shortId: string })`.

- [ ] **Step 1: Rewrite the failing tests first** — in `packages/core/test/brandprint.test.ts`: delete every `theme` assertion; add:

```ts
it("carries the workspace profileId and ignores a personal one", () => {
  expect(resolveBrandprint({ collectionId: "c1", profileId: "p1" }, { collectionId: "c2", profileId: "nope" }))
    .toEqual({ collectionIds: ["c1", "c2"], profileId: "p1" })
})
it("instructions: live profile points at derive://brandprint/profile", () => {
  const s = brandprintInstructions(3, { state: "live", shortId: "abc123" })
  expect(s).toContain("derive://brandprint/profile")
  expect(s).toContain("personal Brandprint takes precedence")
})
it("instructions: pending profile is factual and user-conditioned, never solicits", () => {
  const s = brandprintInstructions(2, { state: "pending", shortId: "abc123" })
  expect(s).toContain("If the user asks")
  expect(s).toContain("for_review")
  expect(s).toContain("abc123")
  expect(s.toLowerCase()).not.toContain("offer")
})
```

- [ ] **Step 2: Run to verify failure**: `corepack pnpm --filter @derive/core test -- brandprint` → FAIL (profileId/args not defined).

- [ ] **Step 3: Implement** — `ports.ts`: `Brandprint = { collectionId?: string; profileId?: string }` (doc comment: profileId is the workspace's generated brand-profile artifact short_id; version 1 is the intake stub); delete `BrandprintTheme` and the `theme` field. `brandprint.ts`: delete `mergeTheme`; `resolveBrandprint` returns `{ collectionIds, profileId: ws?.profileId }`; replace `brandprintInstructions`:

```ts
export const brandprintInstructions = (
  docCount: number,
  profile?: { state: "pending" | "live"; shortId: string },
): string => {
  if (profile?.state === "live")
    return (
      ` This workspace has a Brandprint profile: read derive://brandprint/profile before` +
      ` authoring; your personal Brandprint takes precedence.` +
      (docCount > 0 ? ` ${docCount} source doc${docCount === 1 ? "" : "s"} back it (derive://brandprint/*).` : "")
    )
  const docs =
    docCount > 0
      ? ` This workspace has a Brandprint: ${docCount} convention ${docCount === 1 ? "doc" : "docs"} on how to build things here. Read the derive://brandprint/* resources before authoring; your personal Brandprint takes precedence.`
      : ""
  if (profile?.state === "pending")
    return (
      docs +
      ` Its brand profile has not been generated yet. If the user asks to build or finish` +
      ` their Brandprint, read derive://brandprint/reference and derive://brandprint/template` +
      ` plus the source docs, then publish the profile with for_review:true to artifact ${profile.shortId}.`
    )
  return docs
}
```

- [ ] **Step 4: Run to verify pass**: `corepack pnpm --filter @derive/core test -- brandprint` → PASS. Then `corepack pnpm --filter @derive/core exec tsc --noEmit` (expect downstream API errors; those are Task 3-4's work — only core must be internally clean here, so run `corepack pnpm --filter @derive/core test` fully instead).

- [ ] **Step 5: Commit**: `git add -A && git commit --no-verify -m "feat(brandprint): profileId in the pointer, theme removed, state-aware instructions"`

### Task 3: API — schema + routes

**Files:**
- Modify: `apps/api/src/schemas.ts:292-301` (BrandprintSchema)
- Modify: `apps/api/src/routes/workspace.ts:583-607` (merge + validation)
- Modify: `apps/api/src/routes/session.ts:199-227` (reject profileId at personal scope)
- Test: `apps/api/test/integrations-settings.test.ts`, `apps/api/test/profiles.test.ts`
- Regenerate: `apps/web/src/api-types.ts`

**Interfaces:**
- Produces: `BrandprintSchema = z.object({ collectionId: z.string().trim().max(64).nullish(), profileId: z.string().trim().max(64).nullish() })`. Workspace PATCH validates `profileId` names an artifact in this workspace (via `meta.getByShortId`); personal POST 400s on `profileId` ("brandprint profileId is workspace-only").

- [ ] **Step 1: Write failing tests** — in `integrations-settings.test.ts` (mirror the existing foreign-collection test style): a PATCH with `brandprint: { profileId: <foreign or unknown short_id> }` → 400; a PATCH with a profileId short_id published in this workspace → 200 and round-trips on GET; a PATCH with `theme` → 400 (unknown key now). In `profiles.test.ts`: POST `/v1/me/profile` with `brandprint: { collectionId, profileId }` → 400.

- [ ] **Step 2: Verify failure**: `corepack pnpm --filter @derive/api test -- integrations-settings profiles` → FAIL.

- [ ] **Step 3: Implement.** `schemas.ts`: replace `theme` with `profileId` (update the doc comment: the profile is the generated brand-profile artifact; short_id). `workspace.ts`: keep the one-level merge, replace the theme carry with `profileId`, and validate:

```ts
const m = { ...cur.brandprint, ...brandprint }
if (brandprint.profileId) {
  const art = await meta.getByShortId(brandprint.profileId)
  if (!art || art.org_id !== org)
    return bail(fail(c, 400, "brandprint profile not found in this workspace"))
}
next.brandprint = {
  collectionId: m.collectionId ?? undefined,
  profileId: m.profileId ?? undefined,
}
```

`session.ts`: before the collection check: `if (body.brandprint?.profileId) return bail(fail(c, 400, "brandprint profileId is workspace-only"))`.

- [ ] **Step 4: Regenerate web api types** the way `scripts/check-api-types.mjs` does (read the script; it builds the OpenAPI doc and runs openapi-typescript), then `corepack pnpm --filter @derive/api test -- integrations-settings profiles` → PASS; `corepack pnpm --filter @derive/api exec tsc --noEmit -p tsconfig.json` → expect only `mcp.ts` errors (Task 4).

- [ ] **Step 5: Commit**: `git commit --no-verify -am "feat(brandprint): profileId rides the pointer routes; theme is gone"`

### Task 4: Reference resources + MCP delivery matrix

**Files:**
- Create: `apps/api/src/brandprint-reference.ts` (exports `BRANDPRINT_REFERENCE: string`, `BRANDPRINT_TEMPLATE: string`)
- Modify: `apps/api/src/mcp.ts:258-325` (resolution, resources, instructions)
- Test: `apps/api/test/mcp.test.ts` (extend the existing Brandprint block at line 166)

**Interfaces:**
- Consumes: `resolveBrandprint`, `brandprintInstructions(docCount, profile?)` from Task 2.
- Produces: MCP resources `derive://brandprint/reference` (text/markdown) and `derive://brandprint/template` (text/html) whenever the resolved Brandprint has any collection; `derive://brandprint/profile` (text/html, priority 1) when live; the profile artifact never appears among `derive://brandprint/<short_id>` source resources.

- [ ] **Step 1: Write failing tests** in `mcp.test.ts`, following the existing block's helpers: (a) pending: seed collection + placeholder artifact (publish v1), PATCH pointer `{ collectionId, profileId }` → instructions contain "has not been generated yet", "If the user asks", the short_id; resource list contains `derive://brandprint/reference` and `derive://brandprint/template` but NOT `derive://brandprint/profile`, and not the placeholder among sources. (b) live: publish v2 on the placeholder → instructions contain "Brandprint profile" + `derive://brandprint/profile`; reading `derive://brandprint/profile` returns v2's body. (c) the existing no-profile test still passes untouched.

- [ ] **Step 2: Verify failure**: `corepack pnpm --filter @derive/api test -- mcp` → FAIL.

- [ ] **Step 3: Author `brandprint-reference.ts`.** Two exported template-literal constants, no imports (edge-safe leaf).
  - `BRANDPRINT_REFERENCE` (markdown, ~120 lines): what a brand profile is; the required sections in order — Essence (one-line positioning + narrative), Personality (archetype, 3-5 traits), Color (every color with name/hex/role, a usage ratio like 60/30/10, light+dark values when derivable), Typography (families, weights, scale, pairings), Space & Shape (radius, spacing rhythm, elevation), Voice & Tone (principles plus at least 4 on-brand/off-brand example pairs across headline/empty state/error/CTA), Guardrails (5+ concrete "never" rules), Use with AI (how agents should apply this profile); extraction guidance per section (look docs → color/type/shape, read docs → voice; when a section has no source evidence, write the honest default and mark it `assumption`); and the output contract, verbatim: one self-contained HTML file, no external requests of any kind, responsive at 360-1400px, light and dark supported, all tokens duplicated as CSS custom properties on `:root` AND as a `<script type="application/json" id="brandprint-tokens">` island with shape `{ "color": {...}, "font": {...}, "space": {...}, "radius": {...} }`, W3C-design-tokens-style names; finish by publishing with `for_review: true` to the artifact short_id you were given.
  - `BRANDPRINT_TEMPLATE` (a complete, polished, brand-neutral HTML page, target ≤ 700 lines): a real gold standard in the churnkey.tasteprofile.io mold — sticky section nav, hero with essence statement, personality cards, clickable color swatches showing hex, type specimen blocks, spacing/radius visualizations, voice do/don't two-column pairs, guardrail list, "Use with AI" footer explaining the tokens island; system font stacks (self-containment), neutral placeholder palette, `prefers-color-scheme` dark support, the tokens island populated with the placeholder values; a comment at the top telling the agent: restyle EVERYTHING with the extracted brand — this file demonstrates structure and finish, not the look to keep.

- [ ] **Step 4: Wire `mcp.ts`.** After the `conventionDocs` loop (line ~277):

```ts
const profileShortId = resolved.profileId
const profileArt = profileShortId ? await ctx.meta.getByShortId(profileShortId) : null
const profile =
  profileArt && profileArt.org_id === agent.org_id
    ? ({ state: profileArt.current_version >= 2 ? "live" : "pending", shortId: profileShortId } as const)
    : undefined
const sourceDocs = conventionDocs.filter((d) => d.short_id !== profileShortId)
```

Use `sourceDocs` for the per-doc resource loop and `brandprintInstructions(sourceDocs.length, profile)` in the instructions. When `resolved.collectionIds.length > 0`, register the two static resources (mirror the existing `registerResource` call shape; `brandprint:reference` / `derive://brandprint/reference`, description "How to build this workspace's brand profile", mimeType text/markdown, priority 0.8, static body; template likewise with text/html). When `profile?.state === "live"`, register `brandprint:profile` / `derive://brandprint/profile`, description "This workspace's brand profile — read before authoring", mimeType text/html, priority 1, body = current version text via the same lazy fetch as source docs.

- [ ] **Step 5: Verify pass**: `corepack pnpm --filter @derive/api test -- mcp` → PASS; full `corepack pnpm --filter @derive/api test` + both tsconfigs (`tsc --noEmit -p tsconfig.json` and `-p tsconfig.worker.json`) → clean.

- [ ] **Step 6: Commit**: `git commit --no-verify -am "feat(brandprint): reference resources + profile-first MCP delivery"`

### Task 5: Web intake — placeholder + pointer

**Files:**
- Modify: `apps/web/src/pages/brandprint/use-brandprint-import.ts`
- Create: `apps/web/src/pages/brandprint/profile-placeholder.ts`

**Interfaces:**
- Produces: `PROFILE_PLACEHOLDER_HTML: string` and `placeholderFile(): File` (in profile-placeholder.ts); `ImportResult` gains `profileId?: string`; `useBrandprintImport("workspace", …)` publishes the placeholder into the collection, includes `profileId` in the settings PATCH, and reports it. Account scope unchanged.

- [ ] **Step 1: Implement `profile-placeholder.ts`** — a ~30-line static HTML stub (title "Brand profile", one centered panel: "This brand profile hasn't been generated yet. Your agent builds it from the source documents in this Brandprint." with system fonts and both color schemes), plus:

```ts
export const placeholderFile = () =>
  new File([PROFILE_PLACEHOLDER_HTML], "Brand profile.html", { type: "text/html" })
```

- [ ] **Step 2: Extend the hook.** In the workspace branch of `mutationFn` (line 60-69), after `setCollectionAccess`: publish the placeholder + add to collection inside a try/catch (a placeholder failure must not sink the import — fall back to today's pointer-without-profileId), then PATCH `{ brandprint: { collectionId: target, profileId } }`. Also handle the *existing-collection* case: when `!created && scope === "workspace"`, the pointer may lack a profileId; accept a new `ensureProfile: boolean` option… NO — keep it simple and in-scope: the hook takes `currentProfileId: string | undefined` as a third arg; when workspace scope and `!currentProfileId`, it creates the placeholder and includes `profileId` in a settings PATCH even on the `!created` path. Return it on `ImportResult.profileId`.

- [ ] **Step 3: Update the two call sites** (`brandprint-section.tsx:160`, `welcome.tsx`'s `useBrandprintImport("workspace", "")`) to pass the current profileId (`settings?.brandprint?.profileId` / `undefined`).

- [ ] **Step 4: Verify**: `corepack pnpm --filter @derive/web exec tsc --noEmit` clean; `corepack pnpm --filter @derive/web test` green.

- [ ] **Step 5: Commit**: `git commit --no-verify -am "feat(brandprint): the intake creates the profile placeholder and points at it"`

### Task 6: Web — hand-off brief + profile panel (the five states)

**Files:**
- Create: `apps/web/src/pages/brandprint/profile-panel.tsx` (brief + states, one focused file)
- Modify: `apps/web/src/pages/brandprint/index.tsx` (mount panel; retire ApplyNudge when a profileId exists)
- Modify: `apps/web/src/pages/brandprint/brandprint-section.tsx` (dialog success → hand-off step; hide the placeholder in BrandprintDocs; "Use a collection" save also ensures a placeholder via the Task 5 hook path)
- Modify: `apps/web/src/pages/welcome.tsx:368` (closing copy)

**Interfaces:**
- Consumes: `api.listProposals(shortId, "open")`, `api.approveProposal(shortId, proposalId)`, iframe URLs `${API_BASE}/raw/${shortId}/p/${proposalId}/index.html` and `${API_BASE}/raw/${shortId}/v/${version}/index.html` (the review overlay's exact recipe, `review/body.tsx:28-30`), `ConnectAgentButton`, `workspaceSettingsQuery`, `refFor` for the full-review link.
- Produces: `<ProfilePanel />` rendering: **building card** (profileId set, no open proposal, version 1): "Finish with your agent" — numbered brief in a copyable block (reuse the copy-button pattern from `connect-agent.tsx:136`), ConnectAgentButton beside it, testids `brandprint-brief`, `brandprint-brief-copy`; polls `listProposals` with `refetchInterval: 5000`. **Reveal** (open proposal): full-width sandboxed iframe of the proposal, Approve button (`brandprint-profile-approve`) calling `approveProposal` then invalidating settings/docs queries, and a "Review & comment" `Link` to `/artifacts/$ref`. **Live** (version ≥ 2, no open proposal): iframe of the current version, subtle header row with "Regenerate" (`brandprint-profile-regenerate`) that re-opens the brief card.

The brief text (compose with `API_BASE`; `{shortId}` interpolated):

```
Finish setting up our Brandprint in Derive.
1. Connect to Derive over MCP if you aren't already: claude mcp add --transport http derive {API_BASE}/mcp
2. Read derive://brandprint/reference and derive://brandprint/template, then our source docs (the other derive://brandprint/* resources).
3. Build our brand profile as ONE self-contained HTML file following the reference, and publish it with for_review: true to artifact {shortId}.
```

- [ ] **Step 1: Build `profile-panel.tsx`** per the interface block. State derivation: `profileId = settings?.brandprint?.profileId`; artifact record via a `useQuery` on `api.getArtifact(profileId)` (check `api.ts` for the exact getter name before writing; the artifact page uses one — reuse it) for `current_version`; open proposals query with the poll. Render nothing when no profileId (legacy Brandprints keep today's page).
- [ ] **Step 2: Wire `index.tsx`**: `<ProfilePanel />` between the header and the workspace section; `ApplyNudge` returns null when `settings?.brandprint?.profileId` exists (the panel's states carry the connect story now).
- [ ] **Step 3: `brandprint-section.tsx`**: in `closeOnSuccess`, don't just close — when scope is workspace and `r.profileId` exists, close the dialog (the panel is now visible above with the brief; no second surface needed). Filter `docs.filter((a) => a.short_id !== profileId)` in `BrandprintDocs` (pass profileId down from the section's settings read). "Use a collection": route the save through `importDocs` with zero files? No — call `save(v)` then fire the hook's placeholder path by mutating with an empty file list is contrived; instead extract the placeholder-ensure into the hook's exported helper `ensureProfilePlaceholder(collectionId): Promise<string>` (publish + addToCollection + PATCH) and call it after `save(v)` for workspace scope, best-effort with a caught toast.
- [ ] **Step 4: `welcome.tsx:368` copy** → "Saves when you continue. Your agent then assembles your team's brand profile from it — finish on the Brandprint page."
- [ ] **Step 5: Verify**: web tsc + tests green; `corepack pnpm --filter @derive/web build` to regenerate the route tree is NOT needed (no new route).
- [ ] **Step 6: Commit**: `git commit --no-verify -am "feat(brandprint): hand-off brief, reveal + approve, live profile on /brandprint"`

### Task 7: Gauntlet, push, PR

- [ ] **Step 1: Full verification**: `corepack pnpm exec biome check .`; every `corepack pnpm run lint:*` from the precommit list (skip `lint:api-types` if spawn fails — instead confirm `apps/web/src/api-types.ts` was regenerated in Task 3); `corepack pnpm --filter @derive/core --filter @derive/api --filter @derive/web test`; both api tsconfigs + web tsc.
- [ ] **Step 2: Push + PR**: `git push -u origin feat/brandprint-profile`. `gh` is not installed: prepare the PR body (what/why/how, the serving matrix, the theme funeral, test counts) and give the compare URL `https://github.com/derive-to/derive/compare/main...feat/brandprint-profile?expand=1`. Note in the PR body that `docs/brandprint-status` closes unmerged (its content rides this PR).

## Self-review notes

- Spec coverage: flow (T5/T6), placeholder contract (T5), data model + theme removal (T2/T3), reference resources (T4), no-solicitation instructions (T2/T4), five page states (T6), delivery matrix (T4), personal-scope exclusion (T2 resolve + T3 session 400 + no web changes on account scope), onboarding copy (T6), edge cases (direct publish → live state falls out of `current_version >= 2`; agent-never-returns → building card persists; single-file enforced by proposals).
- Type consistency: `profileId` is a short_id everywhere (`getByShortId` in route + MCP, `raw/:shortId` iframes, brief).
- Known judgment calls for the executor: exact getter name for a single artifact in `api.ts`; `SettingRow`/panel styling should mirror the section's existing classes.
