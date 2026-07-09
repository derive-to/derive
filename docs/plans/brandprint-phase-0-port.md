# Brandprint Phase 0 (Port) Implementation Plan

**For agentic workers.** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the Brandprint delivery layer (workspace + profile conventions, resolved and handed to connected agents over MCP) on current `main`, by porting Anir's tested `feat/house-style` branch forward and renaming House Style to Brandprint.

**Architecture:** `feat/house-style` (commit `c614971`) already built this and is green, but it is 104 commits behind main and two later refactors touch the same files: #328 reworked `apps/api/src/mcp.ts` (`buildServer` grew to 6 params and is synchronous), and #331 made the API contract-first (routes are now `@hono/zod-openapi` `createRoute` / `app.openapi`, and the web client is generated from those route schemas). So this is a hand port, not a rebase: cherry-pick the parts that are pure, re-apply the wiring against the new shapes, rename everything to Brandprint.

**Tech Stack:** TypeScript, pnpm workspaces (`corepack pnpm`), Hono + `@hono/zod-openapi` (API), `@modelcontextprotocol/sdk` (MCP), Vitest, Better Auth, SQLite / Postgres / Cloudflare D1 adapters, Vite + React (web).

## Global Constraints

- **Source of truth for ported code:** git commit `c614971` on `origin/feat/house-style`. Read any file's original with `git show c614971:<path>`. Do not re-type from memory; take the real code and apply the rename.
- **Rename map (apply to every ported identifier, path, string, and test):**

  | Original (`house-style`) | New (`brandprint`) |
  | --- | --- |
  | `packages/core/src/house-style.ts` | `packages/core/src/brandprint.ts` |
  | type `HouseStyle` | `Brandprint` |
  | type `ThemeTokens` | `BrandprintTheme` |
  | `resolveHouseStyle` | `resolveBrandprint` |
  | `parseHouseStyle` | `parseBrandprint` |
  | `houseStyleInstructions` | `brandprintInstructions` |
  | `OrgSettings.houseStyle` | `OrgSettings.brandprint` |
  | Better Auth field + DB column `houseStyle` | `brandprint` |
  | `MetaStore.getUserHouseStyle` | `getUserBrandprint` |
  | `SessionUser.houseStyle` | `brandprint` |
  | MCP resource URI `dock://house-style/<id>` | `derive://brandprint/<id>` (match the current server name `derive`) |
  | `apps/web/src/pages/settings/house-style-section.tsx` | `brandprint-section.tsx` |
  | test files / describe names `*house-style*` | `*brandprint*` |
  | user-facing copy "House Style" | "Brandprint" |

- **No em dashes** in any copy, comment, or commit message. Use commas, colons, or periods. En dashes in numeric ranges are fine.
- **Package manager is `corepack pnpm`** (bare `pnpm` is not on PATH). Every command below uses it.
- **Commit trailer:** end each commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. The repo pre-commit hook runs `pnpm check:fix`; run `corepack pnpm check:fix` before committing so the hook passes.
- **Visual theme application is out of scope** (Anir's Phase B). Port the `BrandprintTheme` type and let it round-trip through storage, but do not render it anywhere.

## File Structure

Created:
- `packages/core/src/brandprint.ts` : pure resolution helpers (renamed from `house-style.ts`).
- `packages/core/test/brandprint.test.ts` : unit tests for the helpers.
- `apps/web/src/pages/settings/brandprint-section.tsx` : the Settings picker (renamed).

Modified:
- `packages/core/src/index.ts` : export `./brandprint`.
- `packages/core/src/ports.ts` : `Brandprint` + `BrandprintTheme` types, `OrgSettings.brandprint`, `MetaStore.getUserBrandprint` + `setUserProfile` `brandprint` field.
- `packages/db/src/{sqlite,pg,d1}.ts` : `getUserBrandprint` + `setUserProfile` `brandprint` branch.
- `packages/db/test/{sqlite-store,pg-store}.test.ts` : brandprint round-trip assertions.
- `apps/api/src/auth-config.ts` : Better Auth additional field `brandprint`.
- `apps/api/src/context.ts` : `SessionUser.brandprint` + wiring.
- `apps/api/src/routes/session.ts` : `/v1/me/profile` accepts `brandprint`.
- `apps/api/src/routes/workspace.ts` : `/v1/workspace/settings` + `OrgSettings` schema accept `brandprint`.
- `apps/api/src/mcp.ts` : resolve brandprint, register resources, append the instructions pointer.
- `apps/api/test/{profiles,mcp}.test.ts` : brandprint assertions.
- `apps/web/src/pages/settings/index.tsx` : mount the section on workspace + account.

---

### Task 0.1: Core brandprint module, types, and unit tests

**Files:**
- Create: `packages/core/src/brandprint.ts`
- Create: `packages/core/test/brandprint.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/ports.ts`

**Interfaces:**
- Produces: `resolveBrandprint(ws?: Brandprint, profile?: Brandprint): { collectionIds: string[]; theme?: BrandprintTheme }`, `parseBrandprint(json: string | null | undefined): Brandprint | undefined`, `brandprintInstructions(docCount: number): string`, and types `Brandprint = { collectionId?: string; theme?: BrandprintTheme }`, `BrandprintTheme` (palette / fonts / dark tokens).
- Consumes: nothing (leaf module).

- [ ] **Step 1: Port the test file first, renamed.** Copy the original into the new path and apply the rename map:

```bash
git show c614971:packages/core/test/house-style.test.ts > packages/core/test/brandprint.test.ts
# then edit brandprint.test.ts: HouseStyle->Brandprint, resolveHouseStyle->resolveBrandprint,
# parseHouseStyle->parseBrandprint, houseStyleInstructions->brandprintInstructions,
# import path "../src/house-style"->"../src/brandprint", and any "house style" strings in the
# pointer assertion to "Brandprint" / "derive://brandprint/". Verify the pointer-text assertion
# matches the exact string produced in Step 3 below.
```

- [ ] **Step 2: Run the test, expect failure.**

Run: `corepack pnpm --filter @dock/core test brandprint`
Expected: FAIL (`Cannot find module '../src/brandprint'`).

- [ ] **Step 3: Create `brandprint.ts` from the original, renamed.** Source is `git show c614971:packages/core/src/house-style.ts`. Apply the rename map. The pointer helper's copy becomes:

```ts
/** The one-line pointer appended to the MCP server `instructions` when conventions
 *  exist. Progressive disclosure: the agent reads the full docs from the resources. */
export const brandprintInstructions = (docCount: number): string =>
  docCount > 0
    ? ` This workspace has a Brandprint: ${docCount} convention ${docCount === 1 ? "doc" : "docs"} on how to build things here. Read the derive://brandprint/* resources before authoring; your personal Brandprint takes precedence.`
    : ""
```

Keep `resolveBrandprint`, `parseBrandprint`, and `mergeTheme` byte-for-byte from the original except the renamed type imports (`import type { Brandprint, BrandprintTheme } from "./ports"`).

- [ ] **Step 4: Add the types to `ports.ts`.** Source is the `ports.ts` hunk of `c614971`. Add, renamed:

```ts
export interface Brandprint {
  /** Collection of convention artifacts (the Brandprint docs). */
  collectionId?: string
  /** Visual theme applied to shell-rendered markdown/skill docs (captured, not yet applied). */
  theme?: BrandprintTheme
}

export interface BrandprintTheme {
  palette?: Partial<Record<"paper" | "panel" | "ink" | "soft" | "muted" | "line" | "accent", string>>
  fonts?: Partial<Record<"body" | "display" | "mono", string>>
  dark?: {
    palette?: Partial<Record<"paper" | "panel" | "ink" | "soft" | "muted" | "line" | "accent", string>>
  }
}
```

Add `brandprint?: Brandprint` to `interface OrgSettings`. Extend `setUserProfile`'s field object with `brandprint?: string | null`, and add `getUserBrandprint(userId: string): Promise<string | null>` to `interface MetaStore`.

- [ ] **Step 5: Export the module.** In `packages/core/src/index.ts`, add `export * from "./brandprint"` in alphabetical position (after `./hash`, before `./ids`).

- [ ] **Step 6: Run the test, expect pass.**

Run: `corepack pnpm --filter @dock/core test brandprint`
Expected: PASS (all brandprint cases green).

- [ ] **Step 7: Typecheck core.**

Run: `corepack pnpm --filter @dock/core typecheck`
Expected: no errors. (`MetaStore` now declares `getUserBrandprint`; the DB adapters implement it in Task 0.2, so if core typecheck references the adapters it may flag until then. Core alone should pass because it only declares the interface.)

- [ ] **Step 8: Commit.**

```bash
corepack pnpm check:fix
git add packages/core/src/brandprint.ts packages/core/test/brandprint.test.ts packages/core/src/index.ts packages/core/src/ports.ts
git commit -m "feat(brandprint): core resolution helpers + types (ported from house-style)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 0.2: DB adapters (sqlite, pg, d1) + store tests

**Files:**
- Modify: `packages/db/src/sqlite.ts`
- Modify: `packages/db/src/pg.ts`
- Modify: `packages/db/src/d1.ts`
- Modify: `packages/db/test/sqlite-store.test.ts`
- Modify: `packages/db/test/pg-store.test.ts`

**Interfaces:**
- Consumes: `MetaStore.getUserBrandprint` + `setUserProfile` shape from Task 0.1.
- Produces: working `getUserBrandprint` / `setUserProfile` `brandprint` on all three adapters. The DB column is `brandprint` (Better Auth adds it in Task 0.3).

- [ ] **Step 1: Write the failing round-trip test (sqlite).** In `packages/db/test/sqlite-store.test.ts`, add:

```ts
it("round-trips a user brandprint (set, read, clear)", async () => {
  const store = createSqliteStore(":memory:")
  const userId = await seedUser(store) // use the file's existing user-seeding helper
  await store.setUserProfile(userId, { brandprint: JSON.stringify({ collectionId: "col_x" }) })
  expect(await store.getUserBrandprint(userId)).toBe(JSON.stringify({ collectionId: "col_x" }))
  await store.setUserProfile(userId, { brandprint: null })
  expect(await store.getUserBrandprint(userId)).toBeNull()
})
```

If the test file has no `seedUser` helper, insert a user row the same way the neighboring profession/about tests in this file do; match their exact setup.

- [ ] **Step 2: Run it, expect failure.**

Run: `corepack pnpm --filter @dock/db test sqlite`
Expected: FAIL (`getUserBrandprint is not a function`).

- [ ] **Step 3: Port the sqlite adapter.** Source: the `sqlite.ts` hunk of `c614971`. In `createSqliteStore`, add to `setUserProfile`:

```ts
if (fields.brandprint !== undefined) {
  sets.push("brandprint = ?")
  args.push(fields.brandprint)
}
```

and add the method:

```ts
getUserBrandprint: async (userId): Promise<string | null> => {
  try {
    const row = raw.prepare("SELECT brandprint FROM user WHERE id = ?").get(userId) as
      | { brandprint?: string | null }
      | undefined
    return row?.brandprint ?? null
  } catch {
    return null // older/minimal user table without the column
  }
},
```

- [ ] **Step 4: Port the pg adapter.** Source: the `pg.ts` hunk of `c614971`. In `setUserProfile` add the `brandprint` branch (quoted column, matches the file's `$${args.length}` style):

```ts
if (fields.brandprint !== undefined) {
  args.push(fields.brandprint)
  sets.push(`"brandprint" = $${args.length}`)
}
```

and the method:

```ts
async getUserBrandprint(userId: string): Promise<string | null> {
  try {
    const r = await this.pool.query(`SELECT "brandprint" FROM "user" WHERE id = $1`, [userId])
    return (r.rows[0]?.brandprint as string | null | undefined) ?? null
  } catch {
    return null // older/minimal user table without the column
  }
}
```

- [ ] **Step 5: Port the d1 adapter.** Source: the `d1.ts` hunk of `c614971`. Add to `setUserProfile`:

```ts
if (fields.brandprint !== undefined)
  await db.run(sql`UPDATE user SET brandprint = ${fields.brandprint} WHERE id = ${userId}`)
```

and the method:

```ts
getUserBrandprint: async (userId: string): Promise<string | null> => {
  try {
    const row = (await db.get(sql`SELECT brandprint FROM user WHERE id = ${userId}`)) as
      | { brandprint?: string | null }
      | undefined
    return row?.brandprint ?? null
  } catch {
    return null // older/minimal user table without the column
  }
},
```

- [ ] **Step 6: Mirror the round-trip test into the pg suite.** Add the same test to `packages/db/test/pg-store.test.ts`, using that file's pg fixture setup (the pg lane has a 15s testTimeout, per #334; do not lower it).

- [ ] **Step 7: Run the db tests, expect pass.**

Run: `corepack pnpm --filter @dock/db test`
Expected: PASS (sqlite green; pg green if the pg lane is configured in this environment. If pg is not available locally, note it and rely on CI for the pg lane.)

- [ ] **Step 8: Commit.**

```bash
corepack pnpm check:fix
git add packages/db/src/sqlite.ts packages/db/src/pg.ts packages/db/src/d1.ts packages/db/test/sqlite-store.test.ts packages/db/test/pg-store.test.ts
git commit -m "feat(brandprint): getUserBrandprint + setUserProfile brandprint across adapters

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 0.3: Auth field + session context wiring

**Files:**
- Modify: `apps/api/src/auth-config.ts`
- Modify: `apps/api/src/context.ts`

**Interfaces:**
- Consumes: `getUserBrandprint` / `setUserProfile` from Task 0.2.
- Produces: `SessionUser.brandprint: string | null` available on the request context; the Better Auth `user.brandprint` column.

- [ ] **Step 1: Add the Better Auth additional field.** In `apps/api/src/auth-config.ts`, in `user.additionalFields` (next to `profession` / `about`), add:

```ts
// Your personal Brandprint: how YOU like artifacts built. Stored as a JSON string
// ({ collectionId?, theme? }); layered over the workspace Brandprint (profile wins)
// when an agent acts as you. input:false, server-set via POST /v1/me/profile.
brandprint: { type: "string", required: false, input: false },
```

- [ ] **Step 2: Thread it through `SessionUser`.** In `apps/api/src/context.ts`, add to `interface SessionUser`:

```ts
/** Personal Brandprint as a JSON string ({ collectionId?, theme? }); null if unset. */
brandprint: string | null
```

Add `brandprint?: string | null` to the `su` cast object, and `brandprint: su.brandprint ?? null` to the constructed `SessionUser` (mirror exactly how `about` is handled two lines up).

- [ ] **Step 3: Typecheck the api app.**

Run: `corepack pnpm --filter @dock/api typecheck`
Expected: no errors from these two files. (Route/MCP consumers land in Tasks 0.4-0.5.)

- [ ] **Step 4: Commit.**

```bash
corepack pnpm check:fix
git add apps/api/src/auth-config.ts apps/api/src/context.ts
git commit -m "feat(brandprint): Better Auth field + SessionUser wiring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 0.4: API routes accept brandprint (contract-first)

**Files:**
- Modify: `apps/api/src/routes/session.ts` (`/v1/me/profile`)
- Modify: `apps/api/src/routes/workspace.ts` (`/v1/workspace/settings` + `OrgSettings` schema)
- Modify: `apps/api/test/profiles.test.ts`

**Interfaces:**
- Consumes: `meta.setUserProfile`, `meta.getOrgSettings`, `meta.setOrgSettings`, `SessionUser.brandprint`.
- Produces: both endpoints read and write `brandprint`; the generated web client (Task 0.6) picks up the field from these OpenAPI schemas.

**Reconciliation note:** Anir's branch predates #331, so his diffs used `readJson(c, z.object(...))`. On current main these routes are `createRoute` / `app.openapi`. Apply the same logic in the current style. Define a shared Zod once near the top of each route file:

```ts
const BrandprintTheme = z.object({
  palette: z.record(z.string(), z.string()).optional(),
  fonts: z.record(z.string(), z.string()).optional(),
  dark: z.object({ palette: z.record(z.string(), z.string()).optional() }).optional(),
})
const BrandprintSchema = z.object({
  collectionId: z.string().trim().max(64).nullish(),
  theme: BrandprintTheme.nullish(),
})
```

- [ ] **Step 1: Write the failing API test.** In `apps/api/test/profiles.test.ts`, add (mirror the file's existing profile-patch test for auth + client setup):

```ts
it("saves and returns a personal brandprint, and clears it with null", async () => {
  const { client } = await signedInClient() // use the file's existing helper
  const saved = await client.post("/v1/me/profile", { brandprint: { collectionId: "col_1" } })
  expect(saved.brandprint).toEqual({ collectionId: "col_1" })
  const cleared = await client.post("/v1/me/profile", { brandprint: null })
  expect(cleared.brandprint).toBeNull()
})
```

Match the actual request/response helper this file already uses; the assertion shape (echo back `brandprint`) is the contract.

- [ ] **Step 2: Run it, expect failure.**

Run: `corepack pnpm --filter @dock/api test profiles`
Expected: FAIL (response has no `brandprint`).

- [ ] **Step 3: Extend `/v1/me/profile` in `session.ts`.** In the `createRoute` for `path: "/v1/me/profile"`:
  - Response schema `z.object({ profession, about })`: add `brandprint: BrandprintSchema.nullable().describe("Saved personal Brandprint; null when cleared.")`.
  - Request body schema `z.object({ profession, about })`: add `brandprint: BrandprintSchema.nullable().optional()`.
  - Handler: after the `about` line, add

```ts
const patch: { profession?: string | null; about?: string | null; brandprint?: string | null } = {}
// ...existing profession/about lines...
if (body.brandprint !== undefined)
  patch.brandprint = body.brandprint ? JSON.stringify(body.brandprint) : null
await meta.setUserProfile(u.id, patch)
return c.json({
  profession: patch.profession ?? null,
  about: patch.about ?? null,
  brandprint: body.brandprint ?? null,
})
```

- [ ] **Step 4: Extend `/v1/workspace/settings` in `workspace.ts`.**
  - The `OrgSettings` response schema (the `z.object(...).openapi("OrgSettings")` near line 91): add `brandprint: BrandprintSchema.optional()`.
  - The PATCH body schema (the `.partial()` object on the settings PATCH `createRoute` near line 572): add `brandprint: BrandprintSchema.nullable()`.
  - Handler: replace the plain `{ ...cur, ...b }` merge with the one-level-deep merge (from `c614971`'s `workspace.ts` hunk, renamed):

```ts
const { brandprint, ...flat } = b
const cur = await meta.getOrgSettings(org)
const next = { ...cur, ...flat }
// Brandprint merges one level deep (set collectionId without wiping theme); null clears.
if (brandprint === null) next.brandprint = undefined
else if (brandprint) {
  const m = { ...cur.brandprint, ...brandprint }
  next.brandprint = { collectionId: m.collectionId ?? undefined, theme: m.theme ?? undefined }
}
await meta.setOrgSettings(org, next)
return c.json(next)
```

- [ ] **Step 5: Run the API test, expect pass.**

Run: `corepack pnpm --filter @dock/api test profiles`
Expected: PASS.

- [ ] **Step 6: Typecheck the api app.**

Run: `corepack pnpm --filter @dock/api typecheck`
Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
corepack pnpm check:fix
git add apps/api/src/routes/session.ts apps/api/src/routes/workspace.ts apps/api/test/profiles.test.ts
git commit -m "feat(brandprint): profile + workspace-settings endpoints accept brandprint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 0.5: MCP delivery (resources + instructions pointer)

**Files:**
- Modify: `apps/api/src/mcp.ts`
- Modify: `apps/api/test/mcp.test.ts`

**Interfaces:**
- Consumes: `resolveBrandprint`, `parseBrandprint`, `brandprintInstructions` (core), `ctx.meta.getOrgSettings`, `ctx.meta.getUserBrandprint`, `ctx.meta.collectionArtifactIds`, `ctx.meta.listArtifacts`, `ctx.meta.getByShortId`, `ctx.meta.getVersion`, `ctx.sourceText`.
- Produces: for a connected agent, one `derive://brandprint/<short_id>` resource per convention doc, plus a one-line pointer appended to the server `instructions`.

**Reconciliation note:** #328 changed `buildServer` to `function buildServer(ctx, agent, actingFor, ownerId, scopeForCap, boundWorkspaces): McpServer` and it is synchronous. Anir's version was `(ctx, agent, ownerId)` and became async. Make the current one async and add `await` at the single call site.

- [ ] **Step 1: Write the failing MCP test.** Port the brandprint assertion from `git show c614971:apps/api/test/mcp.test.ts` into `apps/api/test/mcp.test.ts`, renamed. It should: seed a collection with one convention artifact, set the workspace `brandprint.collectionId`, build the MCP server for an agent, and assert (a) a resource `derive://brandprint/<short_id>` is registered and (b) the server `instructions` contain "This workspace has a Brandprint:". Match the current test file's server-build helper (it now passes the 6-arg `buildServer` shape or a wrapper).

- [ ] **Step 2: Run it, expect failure.**

Run: `corepack pnpm --filter @dock/api test mcp`
Expected: FAIL (no brandprint resource; pointer absent).

- [ ] **Step 3: Make `buildServer` async and resolve brandprint.** Change the signature return type to `): Promise<McpServer> {`. Import the three helpers from core (next to the existing `@dock/core` imports). After the `writeGuidance` block and before `const server = new McpServer(`, add:

```ts
// Resolve the Brandprint for this actor: the workspace's conventions merged with the
// owner's personal ones (profile wins). Each convention doc becomes a readable resource;
// a one-line pointer goes in the instructions (bodies load lazily on read).
const wsBrandprint = (await ctx.meta.getOrgSettings(agent.org_id)).brandprint
const profileBrandprint = parseBrandprint(ownerId ? await ctx.meta.getUserBrandprint(ownerId) : null)
const resolved = resolveBrandprint(wsBrandprint, profileBrandprint)
const conventionDocs: ArtifactRecord[] = []
const seenBp = new Set<string>()
for (const collectionId of resolved.collectionIds) {
  const ids = await ctx.meta.collectionArtifactIds(collectionId)
  for (const a of ids.length ? await ctx.meta.listArtifacts({ ids }) : []) {
    if (!seenBp.has(a.short_id)) {
      seenBp.add(a.short_id)
      conventionDocs.push(a)
    }
  }
}
```

(If `ArtifactRecord` is not already imported in this file, add it to the `@dock/core` import.)

- [ ] **Step 4: Append the pointer to `instructions`.** The current `instructions` string ends with `...so you never need to switch just to open a doc.` immediately before the closing backtick. Append the helper call there:

```ts
        `any of them automatically, so you never need to switch just to open a doc.` +
        brandprintInstructions(conventionDocs.length),
```

- [ ] **Step 5: Register the resources.** Immediately after `const server = new McpServer(...)` (and before the first `server.registerTool`/handler), add:

```ts
// Brandprint conventions as resources: derive://brandprint/<short_id>, bodies fetched
// lazily (the current version's text). audience:["assistant"], context for the agent.
for (const doc of conventionDocs) {
  server.registerResource(
    `brandprint:${doc.short_id}`,
    `derive://brandprint/${doc.short_id}`,
    {
      title: doc.title ?? doc.short_id,
      description: "A Brandprint convention: how this workspace likes its stuff built.",
      mimeType: "text/markdown",
      annotations: { audience: ["assistant"], priority: 0.9 },
    },
    async (uri) => {
      const art = await ctx.meta.getByShortId(doc.short_id)
      const v = art ? await ctx.meta.getVersion(art.id, art.current_version) : null
      const text = v ? await ctx.sourceText(v) : null
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: text ?? "" }] }
    },
  )
}
```

- [ ] **Step 6: Await the call site.** In `mountMcp` (around line 1511), change `const server = buildServer(...)` to `const server = await buildServer(...)`.

- [ ] **Step 7: Run the MCP test, expect pass.**

Run: `corepack pnpm --filter @dock/api test mcp`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
corepack pnpm check:fix
git add apps/api/src/mcp.ts apps/api/test/mcp.test.ts
git commit -m "feat(brandprint): deliver conventions to agents over MCP (resources + pointer)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 0.6: Web Settings section (workspace + account)

**Files:**
- Create: `apps/web/src/pages/settings/brandprint-section.tsx`
- Modify: `apps/web/src/pages/settings/index.tsx`

**Interfaces:**
- Consumes: the generated API client's `brandprint` field on workspace settings and `/v1/me/profile` (from Task 0.4's OpenAPI schemas), plus a collection picker source (the app's existing collections query).
- Produces: a Settings control to point the workspace's and the account's Brandprint at an existing collection, and to clear it.

**Reconciliation note:** This is the fuzziest port because #331 changed the web data layer from hand-written `api.ts` methods to a generated client. Do NOT copy Anir's `api.ts` hunk. Instead, read the current `apps/web/src/api.ts` and a sibling section (`apps/web/src/pages/settings/github-section.tsx` or `general-section.tsx`) to learn the current call pattern, then port the component to it.

- [ ] **Step 1: Read the original component and the current patterns.**

```bash
git show c614971:apps/web/src/pages/settings/house-style-section.tsx   # the component to port
git show c614971:apps/web/src/pages/settings/index.tsx                 # how it was mounted (+11 lines)
```

Open `apps/web/src/api.ts` and `apps/web/src/pages/settings/general-section.tsx` on the current branch to see how a section reads/writes settings today (query hook + mutation via the generated client).

- [ ] **Step 2: Create `brandprint-section.tsx`.** Port the original's JSX and behavior, renamed to Brandprint, but swap its data calls for the current generated-client equivalents you found in Step 1. Keep it a single component that takes a `scope: "workspace" | "account"` prop (as the original did) so it renders in both places. It reads the current `brandprint.collectionId`, offers the collection picker, and writes via the workspace-settings mutation (workspace scope) or the `/v1/me/profile` mutation (account scope). Clearing sets `brandprint: null`.

- [ ] **Step 3: Mount it in `settings/index.tsx`.** Add `<BrandprintSection scope="workspace" />` to the workspace settings group and `<BrandprintSection scope="account" />` to the account group, matching how neighboring sections are placed (source: the original `index.tsx` hunk, adapted to the current file's structure).

- [ ] **Step 4: Typecheck + build web.**

Run: `corepack pnpm --filter @dock/web typecheck && corepack pnpm --filter @dock/web build`
Expected: no type errors; build succeeds.

- [ ] **Step 5: If the web suite has a settings test, extend it; otherwise add a light render test.** Add a test that renders `BrandprintSection` with a mocked settings response and asserts the current collection shows and a change fires the mutation. Match the web test harness already in `apps/web` (Vitest + Testing Library).

Run: `corepack pnpm --filter @dock/web test brandprint`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
corepack pnpm check:fix
git add apps/web/src/pages/settings/brandprint-section.tsx apps/web/src/pages/settings/index.tsx
git commit -m "feat(brandprint): Settings picker on workspace + account

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 0.7: Full green gate and PR

**Files:** none (verification + PR).

- [ ] **Step 1: Run the full workspace check.**

Run: `corepack pnpm check` then `corepack pnpm -r test`
Expected: typecheck + biome clean, all package test suites green. Fix anything red before proceeding; do not open the PR on a red tree.

- [ ] **Step 2: Manual smoke (optional but recommended).** Point a workspace's Brandprint at a collection with one markdown doc, connect an agent over MCP, and confirm the agent sees a `derive://brandprint/<id>` resource and the pointer line in its instructions.

- [ ] **Step 3: Push and open the PR.**

```bash
git push -u origin feat/brandprint
```

Open a PR titled `Brandprint Phase 0: team style conventions delivered to agents over MCP`. Body: summarize that this ports `feat/house-style` (`c614971`) forward, renamed to Brandprint, reconciled against #328 (mcp) and #331 (contract-first API); note theme application is deferred; link `docs/plans/brandprint.md`. End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Follow-on plans (not in this document)

Written against the concrete surface once Phase 0 lands:

- **Phase 1 (capture):** `POST /v1/brandprint/seed` (inference-free artifact + collection + pointer), the shared `<ConnectAgent>` surface extracted from `welcome.tsx` Step 2, the Settings intake, and the conditional workspace-scoped onboarding Step 3.
- **Phase 2 (apply):** the "Rework with Brandprint" item in the artifact overflow menu, `POST /v1/artifacts/:shortId/rework` (canned @mention into the agent inbox), and the no-agent routing.

## Self-review

- **Spec coverage (Phase 0 slice):** data model (Tasks 0.1-0.3), MCP delivery (0.5), Settings surface (0.6), API endpoints for brandprint (0.4), the port plan and rename (Global Constraints + every task), testing (each task + 0.7). Phase 1/2 spec sections are intentionally deferred to follow-on plans, noted above.
- **Placeholder scan:** none. Ported code that would be verbatim is referenced by `git show c614971:<path>` plus the rename map, which is a real, executable instruction, not a "TODO".
- **Type consistency:** `Brandprint` / `BrandprintTheme` / `resolveBrandprint` / `parseBrandprint` / `brandprintInstructions` / `getUserBrandprint` / `OrgSettings.brandprint` / `SessionUser.brandprint` are used identically across Tasks 0.1-0.6. The `derive://brandprint/<id>` resource URI matches between the pointer helper (0.1), the MCP registration (0.5), and the test (0.5).
