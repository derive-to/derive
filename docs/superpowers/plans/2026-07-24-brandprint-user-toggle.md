# Per-user Brandprint Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A personal "use workspace Brandprint" switch (default on); off drops the workspace layer (conventions collection + brand profile) for that user across MCP, rework, and contexts, keeps their personal layer, and rework returns a distinct "disabled" error surfaced as a small message in the UI.

**Architecture:** One new optional field (`useWorkspaceBrandprint`) inside the existing personal-brandprint JSON on the user row; one suppression check in the pure `resolveBrandprint`, which every consumer already flows through; a `workspaceSuppressed` marker on `ResolvedBrandprint` so rework can tell "disabled" from "missing"; a Switch in the Brandprint page's account section riding the existing `/v1/me` save path (fixed to merge, not clobber).

**Tech Stack:** TypeScript monorepo (pnpm), Hono + zod-openapi, Vitest, React. Worktree: `.claude/worktrees/brandprint-user-toggle`, branch `feat/brandprint-user-toggle` (based on origin/main 521afbc).

**Spec:** `docs/superpowers/specs/2026-07-24-brandprint-user-toggle-design.md`

## Global Constraints

- Absent field or `true` = today's behavior exactly; only explicit `false` suppresses. Only the PERSONAL layer carries the field; the workspace-settings write path must not accept it.
- With the toggle off, a personal collection still applies (rework proceeds on it; MCP still serves personal conventions).
- No schema migration; no Better-Auth field changes.
- Test scoping: `corepack pnpm exec vitest run <pattern>` inside the package dir (the `pnpm --filter X test -- pattern` form does NOT scope in this repo).
- No em dashes in any user-facing copy or comments you write. New interactive controls need `data-testid` (`lint:testids`); no hardcoded colors/text sizes (`lint:tokens`).
- Commits: conventional, ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Precommit hook must run (never `--no-verify`).

---

### Task 1: Core — the field, the suppression, and the marker

**Files:**
- Modify: `packages/core/src/ports.ts` (the `Brandprint` interface, ~line 2087)
- Modify: `packages/core/src/brandprint.ts` (`ResolvedBrandprint`, `resolveBrandprint`)
- Test: `packages/core/test/brandprint.test.ts`

**Interfaces:**
- Produces: `Brandprint.useWorkspaceBrandprint?: boolean`; `ResolvedBrandprint.workspaceSuppressed?: boolean` (true only when a workspace layer existed and the personal toggle dropped it); `resolveBrandprint` drops `ws` entirely when `profile?.useWorkspaceBrandprint === false`.

- [ ] **Step 1: Failing tests** — append to the existing `describe("resolveBrandprint")` in `packages/core/test/brandprint.test.ts` (match its existing style; read the current cases first):

```ts
  it("toggle off drops the workspace layer but keeps the personal collection", () => {
    const r = resolveBrandprint(
      { collectionId: "ws-col", profileId: "prof" },
      { collectionId: "my-col", useWorkspaceBrandprint: false },
    )
    expect(r.collectionIds).toEqual(["my-col"])
    expect(r.profileId).toBeUndefined()
    expect(r.workspaceSuppressed).toBe(true)
  })

  it("toggle off with no personal layer resolves empty, marked suppressed", () => {
    const r = resolveBrandprint({ collectionId: "ws-col" }, { useWorkspaceBrandprint: false })
    expect(r.collectionIds).toEqual([])
    expect(r.profileId).toBeUndefined()
    expect(r.workspaceSuppressed).toBe(true)
  })

  it("toggle off with no workspace layer is not marked suppressed", () => {
    const r = resolveBrandprint(undefined, { collectionId: "my-col", useWorkspaceBrandprint: false })
    expect(r.collectionIds).toEqual(["my-col"])
    expect(r.workspaceSuppressed).toBeUndefined()
  })

  it("absent and true both keep today's merge", () => {
    for (const p of [{ collectionId: "my-col" }, { collectionId: "my-col", useWorkspaceBrandprint: true }]) {
      const r = resolveBrandprint({ collectionId: "ws-col", profileId: "prof" }, p)
      expect(r.collectionIds).toEqual(["ws-col", "my-col"])
      expect(r.profileId).toBe("prof")
      expect(r.workspaceSuppressed).toBeUndefined()
    }
  })

  it("parseBrandprint round-trips the toggle", () => {
    expect(parseBrandprint('{"useWorkspaceBrandprint":false}')).toEqual({
      useWorkspaceBrandprint: false,
    })
  })
```

- [ ] **Step 2: Run to fail** — `cd packages/core && corepack pnpm exec vitest run brandprint` → new cases fail (unknown property / wrong merge).

- [ ] **Step 3: Implement.** `ports.ts`, inside `interface Brandprint` after `profileId`:

```ts
  /** Personal-layer only: false turns the WORKSPACE Brandprint off for this user
   *  (their agents skip the org's conventions and profile; a personal collection
   *  above still applies). Absent or true = the workspace layer applies. A
   *  workspace's own settings never carry this field. */
  useWorkspaceBrandprint?: boolean
```

`brandprint.ts` — extend `ResolvedBrandprint`:

```ts
  /** True when a workspace layer existed but the personal toggle dropped it.
   *  Lets rework tell "you turned it off" from "nothing is set up". */
  workspaceSuppressed?: boolean
```

and replace `resolveBrandprint`:

```ts
export const resolveBrandprint = (ws?: Brandprint, profile?: Brandprint): ResolvedBrandprint => {
  // The personal toggle: false removes the workspace layer wholesale. The personal
  // collection is the user's own opt-in, so it survives the toggle.
  if (profile?.useWorkspaceBrandprint === false) {
    const hadWs = !!(ws?.collectionId || ws?.profileId)
    return {
      collectionIds: profile.collectionId ? [profile.collectionId] : [],
      ...(hadWs ? { workspaceSuppressed: true } : {}),
    }
  }
  const ids = [ws?.collectionId, profile?.collectionId].filter((id): id is string => !!id)
  return { collectionIds: [...new Set(ids)], profileId: ws?.profileId }
}
```

- [ ] **Step 4: Green** — `corepack pnpm exec vitest run brandprint` in packages/core, then the full core suite `corepack pnpm exec vitest run`. All pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ports.ts packages/core/src/brandprint.ts packages/core/test/brandprint.test.ts
git commit -m "feat(core): personal toggle suppresses the workspace Brandprint layer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: API — persist the toggle through /v1/me; workspace route must not accept it

**Files:**
- Modify: `apps/api/src/schemas.ts` (`PersonalBrandprintSchema`, ~line 299)
- Test: `apps/api/test/` — extend the suite that covers `POST /v1/me` profile saves (grep for `setProfile`/`/v1/me` in apps/api/test; likely a session/profile test file)

**Interfaces:**
- Consumes: `Brandprint.useWorkspaceBrandprint` (Task 1).
- Produces: `PersonalBrandprintSchema` accepts + documents `useWorkspaceBrandprint?: boolean`; `POST /v1/me` persists it inside the JSON blob (handler at `apps/api/src/routes/session.ts:~198-238` already `JSON.stringify`s the parsed body, so accepting it in the schema is the only change needed there — verify by test, not assumption); the workspace-settings PATCH silently strips it (zod default object stripping — prove with a test).

- [ ] **Step 1: Failing tests** (adapt to the harness in the existing profile tests — `makeAuthedApp`/`as`/`jsonAs` per `apps/api/test/helpers.ts`):

```ts
  it("persists and returns the personal Brandprint toggle", async () => {
    const r = await (
      await appX.request("/v1/me", jsonAs(as("u@x.co"), { brandprint: { useWorkspaceBrandprint: false } }))
    ).json()
    expect(r.brandprint).toEqual({ useWorkspaceBrandprint: false })
    const me = await (await appX.request("/v1/me", { headers: as("u@x.co") })).json()
    expect(me.brandprint?.useWorkspaceBrandprint).toBe(false)
  })

  it("saving a collection alongside the toggle keeps both", async () => {
    // collectionId must be a real collection owned by the caller's workspace —
    // create one first via the harness (see the existing personal-brandprint
    // ownership tests for the pattern).
  })

  it("the workspace settings route strips the toggle", async () => {
    // PATCH workspace settings with brandprint: { collectionId: <real>, useWorkspaceBrandprint: false }
    // → 200, and a GET shows the stored workspace brandprint WITHOUT the field.
  })
```

Fill the two sketches with the harness's real collection-creation pattern (the existing tests that exercise `brandprint collection not found` show it). No empty tests in the final diff.

- [ ] **Step 2: Run to fail** — the first test fails now (zod strips the unknown field, so `r.brandprint` comes back `{}`... verify the actual failure mode and note it in the report).

- [ ] **Step 3: Implement.** `schemas.ts`:

```ts
export const PersonalBrandprintSchema = BrandprintSchema.omit({ profileId: true }).extend({
  useWorkspaceBrandprint: z
    .boolean()
    .optional()
    .describe(
      "False turns the workspace Brandprint off for this user; their personal collection still applies. Absent or true: the workspace layer applies. Personal scope only.",
    ),
})
```

Check `GET /v1/me`'s response path returns the parsed stored JSON (it does not re-validate through a stripping schema at runtime); if a response schema in `session.ts` needs the field added for the OpenAPI spec to document it, add it there too (the GET's `brandprint` response schema).

- [ ] **Step 4: Green + regen** — API tests for the touched files green; then `corepack pnpm gen:openapi` (in apps/api) and `corepack pnpm gen:api-types` (in apps/web); `pnpm lint:api-types` from root ok.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/schemas.ts apps/api/src/routes/session.ts apps/api/openapi.json apps/web/src/api-types.ts apps/api/test/
git commit -m "feat(api): persist the personal use-workspace-Brandprint toggle on /v1/me

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Include `session.ts` only if Step 3 actually touched it.)

---

### Task 3: API — rework distinguishes disabled from missing; MCP suppression proven

**Files:**
- Modify: `apps/api/src/routes/rework.ts` (empty-brief guard, ~lines 176-186)
- Test: the existing rework test file (grep apps/api/test for `needsBrandprint`) + the MCP brandprint test file (grep apps/api/test for `derive://brandprint`)

**Interfaces:**
- Consumes: `ResolvedBrandprint.workspaceSuppressed` (Task 1); the persisted toggle (Task 2).
- Produces: rework 409 `code: "brandprintDisabled"`, message `"Brandprint is turned off in your settings. Turn it on to rework."` when the brief is empty because of suppression; existing `needsBrandprint` unchanged when nothing was ever set. Task 4's web branch keys on `brandprintDisabled`.

- [ ] **Step 1: Failing tests** (in the rework suite, using its existing setup for workspace brandprint + registered agent):

```ts
  it("409s brandprintDisabled when the caller turned the workspace Brandprint off", async () => {
    // workspace HAS a brandprint; caller saves { useWorkspaceBrandprint: false } with no
    // personal collection via /v1/me; rework → 409 with code "brandprintDisabled"
  })

  it("rework proceeds on the personal collection when the workspace layer is off", async () => {
    // caller saves { collectionId: <their own real collection>, useWorkspaceBrandprint: false }
    // → rework succeeds (request posted)
  })

  it("no brandprint anywhere still 409s needsBrandprint", async () => { /* unchanged path */ })
```

Fill from the suite's existing patterns; assert the exact `code` and that the message names settings.

Also extend the MCP brandprint test: a user whose toggle is off connecting over MCP gets NO workspace `derive://brandprint/*` resources (and no profile resource), while a personal-collection doc still appears. Follow the file's existing connect-and-list-resources pattern exactly.

- [ ] **Step 2: Run to fail** — first test currently gets `needsBrandprint` (wrong code).

- [ ] **Step 3: Implement.** In `rework.ts`, replace the empty-brief guard:

```ts
      if (resolved.collectionIds.length === 0 && !resolved.profileId)
        return bail(
          resolved.workspaceSuppressed
            ? fail(c, 409, "Brandprint is turned off in your settings. Turn it on to rework.", {
                code: "brandprintDisabled",
              })
            : fail(c, 409, "no Brandprint is set on this workspace or your profile", {
                code: "needsBrandprint",
              }),
        )
```

Update the route's OpenAPI `description` string (~line 160) to name the third 409 code, then regen: `corepack pnpm gen:openapi` (apps/api) + `corepack pnpm gen:api-types` (apps/web); `pnpm lint:api-types` ok.

Also extend the doc comment on `resolveActorBrandprint` (`apps/api/src/lib/brandprint.ts:8-14`) with the caveat the spec names: context runs key on the context CREATOR's id, so a creator's toggle governs that context's sessions regardless of who reads them.

- [ ] **Step 4: Green** — rework + MCP suites green; full apps/api suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/rework.ts apps/api/openapi.json apps/web/src/api-types.ts apps/api/test/
git commit -m "feat(api): rework tells a disabled Brandprint apart from a missing one

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Web — the switch, merge-preserving saves, and the rework error branch

**Files:**
- Modify: `apps/web/src/pages/brandprint/brandprint-section.tsx` (account scope: add the switch; fix the clobbering save)
- Modify: `apps/web/src/pages/artifact/rework-menu-item.tsx` (the `onError` branch, ~line 65)
- Test: any pure helper you extract gets a unit test; otherwise lints + typecheck are the gate (this repo has no component render harness)

**Interfaces:**
- Consumes: `me.brandprint.useWorkspaceBrandprint` from the regenerated types; `brandprintDisabled` error code (Task 3).
- Produces: a `data-testid="brandprint-workspace-toggle"` switch; `api.setProfile` calls that MERGE the existing personal brandprint instead of clobbering it.

- [ ] **Step 1: Fix the clobber first.** `brandprint-section.tsx` `updateAccount` (~line 168) currently writes `{ brandprint: collectionId ? { collectionId } : null }`, which would wipe the toggle on every collection save (and clearing the collection would clear the toggle too). Change account-scope saves to spread the current personal object:

```ts
    mutationFn: (collectionId: string | null) =>
      api.setProfile({
        brandprint: collectionId || me?.brandprint?.useWorkspaceBrandprint === false
          ? { ...me?.brandprint, collectionId: collectionId || undefined }
          : null,
      }),
```

(Read the surrounding code and keep its exact optimistic/setMe flow; the rule is: a save must never drop a field it wasn't changing, and `null` clears only when nothing else remains.)

- [ ] **Step 2: The switch.** In the account scope of `brandprint-section.tsx`, render (only when the ACTIVE workspace has a brandprint configured — the section already reads `settings?.brandprint`):

```tsx
  {(settings?.brandprint?.collectionId || settings?.brandprint?.profileId) && (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-sm font-medium">Use workspace Brandprint</div>
        <p className="text-xs text-muted-foreground">
          Off: your agents skip this workspace's style and profile. Your personal
          conventions above still apply.
        </p>
      </div>
      <Switch
        data-testid="brandprint-workspace-toggle"
        checked={me?.brandprint?.useWorkspaceBrandprint !== false}
        onCheckedChange={(on) => toggleWorkspace.mutate(on)}
      />
    </div>
  )}
```

with a `toggleWorkspace` `useApiMutation` that calls `api.setProfile({ brandprint: { ...me?.brandprint, useWorkspaceBrandprint: on ? undefined : false } })` (write `undefined`, not `true`, so "on" stores nothing and the absent-means-on rule holds; if the resulting object is empty, send `null`), then mirrors into `setMe` the way `updateAccount` does. Copy layout classes from the section's existing rows, import the repo's `Switch` component (grep `from "@/components/ui/switch"` for usage). Adjust copy/classes to the file's idiom; keep the testid.

- [ ] **Step 3: Rework error branch.** In `rework-menu-item.tsx` `onError`:

```ts
      else if (code === "brandprintDisabled")
        toast.error("Brandprint is turned off in your settings. Turn it on to rework.")
```

placed before the generic fallback; do NOT change the `needsBrandprint` → `/brandprint` navigation.

- [ ] **Step 4: Verify** — `corepack pnpm --filter @derive/web typecheck`; `cd apps/web && npx vitest run`; from root `node scripts/check-testids.mjs && node scripts/check-design-tokens.mjs && node scripts/check-frontend.mjs`. All green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/brandprint/brandprint-section.tsx apps/web/src/pages/artifact/rework-menu-item.tsx
git commit -m "feat(web): personal use-workspace-Brandprint switch + disabled rework notice

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Full gate + PR handoff

- [ ] `pnpm -r test && pnpm -r typecheck && pnpm precommit` from the worktree root — all green, fix anything that is not.
- [ ] Push: `git push -u origin feat/brandprint-user-toggle`.
- [ ] `gh` is NOT installed. Output the PR URL (`https://github.com/derive-to/derive/pull/new/feat/brandprint-user-toggle`) plus title `Personal toggle: turn the workspace Brandprint off for yourself` and a body pasted INLINE in the reply (never saved to a file): summary of the four changes, the merge-preserving save fix, the caveats (global not per-workspace; context runs key on the creator), test evidence, a manual test plan (toggle off → MCP resources gone, rework shows the notice; toggle on → parity with today), and the standard attribution line.
