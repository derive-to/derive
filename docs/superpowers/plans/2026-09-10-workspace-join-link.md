# Workspace Join Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shareable, revocable, seat-gated link per workspace that lets anyone who opens it join at Creator (default) or Viewer, with a join page that finishes the join automatically after sign-in.

**Architecture:** A new `workspace_join_link` table (plaintext token, one row per workspace) behind six store methods, five routes in a new `apps/api/src/routes/workspace-join.ts` router mounted next to the workspace router, a `JoinLinkCard` in the members settings section, and a `/join/$token` page that reuses the invitation panel and the `/claim/$token` `?go=1` auto-resume pattern. Copy is pure and unit-tested in `join-link-copy.ts`.

**Tech Stack:** TypeScript, Hono + `@hono/zod-openapi`, drizzle (sqlite/D1 + Postgres mirrors), TanStack Router/Query, vitest, Playwright. Package manager is `corepack pnpm` (bare `pnpm` is not on PATH).

**Spec:** `docs/superpowers/specs/2026-09-10-workspace-join-link-design.md` (Derive artifact `562f9sa2` v7 is the design-time record).

## Global Constraints

- Work in the worktree `.claude/worktrees/workspace-join-link` on branch `feat/workspace-join-link` (off `origin/main` aa9a0b23). Never touch `main`. Commit as `Connor <cpellan561@gmail.com>`.
- Clean-room: build from Derive's own patterns (the invitation flow), never from another product's code.
- Token at rest is PLAINTEXT (spec decision 1). Default link role is `editor` (spec decision 2). `?go=1` auto-resume on the join page only (spec decision 3).
- The link never grants `owner`. Only `commenter` and `editor` are accepted.
- Fixed 30-day expiry. Create and rotate are the same store operation (`replaceJoinLink`).
- Copy is final, from Connor (2026-09-10). Prices come from `unitPrice(tier, interval)` in `apps/web/src/pages/settings/billing-plans.ts`, never hardcoded, so Business ($30) and annual ($12) read correctly:
  - Free card line: `Free covers 3 Creators. A 4th moves you to Team, where every Creator and Admin is $15/mo.`
  - Team card line: `Every Creator and Admin is $15/mo. Each join adds one.`
  - Billing-off (beta) line: `Billing is off on this instance, so Creators stay free.`
  - Confirm dialog: title `Create a Creator link?`, body `Everyone who joins becomes a Creator and adds $15/mo to {workspace}'s bill. Revoke the link any time.`, confirm button `Create link`.
  - Live Creator link line: `Each join adds a Creator at $15/mo.`
  - Join page seat limit: `{workspace} has no Creator seats left. Ask {inviter} for a Viewer link or an upgrade.`
  - Join page expired: title `This link has expired`, description `Ask {inviter} for a new one.`
  - Join page revoked/unknown: title `This link is invalid or has been revoked`, description `Ask a workspace Admin for a new one.`
- No em dashes in any copy or comment you write. Use commas, colons, or periods.
- Schema changes land together in `packages/db/src/schema.ts`, `packages/db/src/pg-schema.ts` (both `TABLES` lists), `packages/db/src/parity.ts`, and the regenerated `deploy/d1-schema.sql`. A new column must be nullable or carry a constant default (`ddl.ts` `isMigratable`).
- Generated files are regenerated, never hand-edited: `deploy/d1-schema.sql` (`corepack pnpm --filter @derive/db gen:d1-schema`), `apps/api/openapi.json` (`corepack pnpm --filter @derive/api gen:openapi`), `apps/web/src/api-types.ts` (`corepack pnpm --filter @derive/web gen:api-types`), `apps/web/src/routeTree.gen.ts` (the TanStack Start vite plugin regenerates it during `corepack pnpm --filter @derive/web build`).
- Gates before the PR: `corepack pnpm --filter @derive/core typecheck`, `--filter @derive/db typecheck`, `--filter @derive/api typecheck`, `--filter @derive/web typecheck`, `corepack pnpm biome check .` (or the root lint script), `node scripts/check-schema.mjs`, `node scripts/check-api-types.mjs`, `corepack pnpm -r test`. The `apps/api/test/mcp.test.ts` flake under coverage is pre-existing; baseline main before blaming the diff.
- Do not open the PR yourself (gh cannot create PRs on this repo). Push the branch, then paste the PR title and body inline in chat.

---

## File structure

| File | Responsibility |
| --- | --- |
| `packages/core/src/ports.ts` | `JoinLinkRecord`, `NewJoinLink`, six store methods next to the invitation methods |
| `packages/db/src/schema.ts`, `pg-schema.ts` | `workspaceJoinLink` table (sqlite/D1 and Postgres mirrors), `TABLES` entries |
| `packages/db/src/parity.ts` | `workspaceJoinLink: JoinLinkRecord` in `TypedTables` |
| `packages/db/src/repos.ts`, `pg.ts` | the six methods, one per dialect |
| `packages/db/test/store-contract.ts` | contract test for the six methods |
| `deploy/d1-schema.sql` | regenerated |
| `apps/api/src/lib/join-link.ts` | TTL, liveness, role guard, JSON shape |
| `apps/api/src/lib/signup-policy.ts` | `InviteKind` gains `join`; policy branch for it |
| `apps/api/src/routes/workspace-join.ts` | the five routes |
| `apps/api/src/app.ts` | mount `workspaceJoinRoutes` |
| `apps/api/test/join-link.test.ts` | route tests |
| `apps/api/test/billing-seats.test.ts` | seat gate through the link |
| `apps/api/test/signup-policy.test.ts` | the `join` kind |
| `apps/api/openapi.json`, `apps/web/src/api-types.ts` | regenerated |
| `apps/web/src/api.ts` | types + five client methods |
| `apps/web/src/lib/queries.ts` | `workspaceJoinLinkQuery` |
| `apps/web/src/pages/settings/join-link-copy.ts` (+ `.test.ts`) | the pure copy helpers |
| `apps/web/src/pages/settings/join-link-card.tsx` | the card |
| `apps/web/src/pages/settings/members-section.tsx` | renders the card for Admins |
| `apps/web/src/pages/accept-invite.tsx` | export `Shell` and `InvitationPanel` |
| `apps/web/src/pages/join-workspace.tsx`, `apps/web/src/routes/join.$token.tsx` | the join page |
| `apps/web/src/routeTree.gen.ts` | regenerated |
| `apps/web/e2e/join-link.smoke.spec.ts` | end-to-end: create link, second person joins |
| `docs/access-model.md` | one paragraph on the join link |

---

### Task 1: Table, record types, parity, D1 schema

**Files:**
- Modify: `packages/core/src/ports.ts` (after `NewInvitation`, around line 3162)
- Modify: `packages/db/src/schema.ts` (after `collectionInvite`, around line 627; `TABLES` around line 1371)
- Modify: `packages/db/src/pg-schema.ts` (after `collectionInvite`; `TABLES` around line 1153)
- Modify: `packages/db/src/parity.ts` (import + `TypedTables`)
- Regenerate: `deploy/d1-schema.sql`

**Interfaces:**
- Produces: `JoinLinkRecord`, `NewJoinLink` (exported from `@derive/core` via `export * from "./ports"`), drizzle tables `workspaceJoinLink` in both schema files.

- [ ] **Step 1: Add the record types to ports.ts** (right after the `NewInvitation` interface)

```ts
/**
 * A workspace join link: ONE shareable, revocable URL per workspace that lets anyone who
 * opens `/join/<token>` join at a chosen role. Unlike `invitation` it is bound to no email,
 * is multi-use, and is never consumed. The token is stored in PLAINTEXT on purpose: it is a
 * revocable, 30-day, seat-gated secret meant to be pasted into a team channel and copied
 * again from Settings later, and anyone with database read access can already read
 * `membership`. Owner is never grantable through it.
 */
export interface JoinLinkRecord {
  id: string
  org_id: string
  /** The role a joiner receives: commenter (Viewer) or editor (Creator). Never owner. */
  role: Role
  /** The raw join token (plaintext by design, see above); the URL is `/join/<token>`. */
  token: string
  /** The Admin who created it; null if their account was later removed. */
  created_by: string | null
  created_at: string
  /** Fixed 30 days from creation; rotating the link is the only way to extend it. */
  expires_at: string
  /** How many people have joined through this link. */
  join_count: number
}
export interface NewJoinLink {
  id: string
  org_id: string
  role: Role
  token: string
  created_by?: string | null
  expires_at: string
}
```

- [ ] **Step 2: Add the sqlite/D1 table to schema.ts** (after `collectionInvite`)

```ts
// One shareable, revocable join link per workspace: anyone who opens `/join/<token>` joins
// at `role`. Not an `invitation`: no email, multi-use, never consumed. The token is stored
// in plaintext on purpose (see JoinLinkRecord in @derive/core) so an Admin can copy the
// link again from Settings without rotating it.
export const workspaceJoinLink = sqliteTable(
  "workspace_join_link",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    role: text("role").$type<Role>().notNull().default("editor"),
    token: text("token").notNull(),
    created_by: text("created_by"),
    created_at: text("created_at").notNull().default(now),
    expires_at: text("expires_at").notNull(),
    join_count: integer("join_count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("workspace_join_link_org").on(t.org_id),
    uniqueIndex("workspace_join_link_token").on(t.token),
  ],
)
```

Add `workspaceJoinLink,` to `TABLES` right after `collectionInvite,`.

- [ ] **Step 3: Mirror it in pg-schema.ts** (after `collectionInvite`; `created_at` uses `.$defaultFn(isoNow)` like the pg `invitation` table; confirm `integer` is already imported from `drizzle-orm/pg-core`, add it if not)

```ts
// One join link per workspace (see schema.ts for the full note).
export const workspaceJoinLink = pgTable(
  "workspace_join_link",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id").notNull(),
    role: text("role").$type<Role>().notNull().default("editor"),
    token: text("token").notNull(),
    created_by: text("created_by"),
    created_at: text("created_at").notNull().$defaultFn(isoNow),
    expires_at: text("expires_at").notNull(),
    join_count: integer("join_count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("workspace_join_link_org").on(t.org_id),
    uniqueIndex("workspace_join_link_token").on(t.token),
  ],
)
```

Add `workspaceJoinLink,` to the pg `TABLES` after `collectionInvite,`.

- [ ] **Step 4: Classify it in parity.ts**: add `JoinLinkRecord` to the `@derive/core` import list and `workspaceJoinLink: JoinLinkRecord` to `TypedTables` (after `invitation: InvitationRecord`).

- [ ] **Step 5: Typecheck core and db**

Run: `corepack pnpm --filter @derive/core typecheck && corepack pnpm --filter @derive/db typecheck`
Expected: both pass. If parity complains about a shape mismatch, the drizzle row and `JoinLinkRecord` differ; fix the record, not the table.

- [ ] **Step 6: Regenerate the D1 schema and check schema parity**

Run: `corepack pnpm --filter @derive/db gen:d1-schema && node scripts/check-schema.mjs && git diff --stat deploy/d1-schema.sql`
Expected: `deploy/d1-schema.sql` gains a `CREATE TABLE IF NOT EXISTS workspace_join_link` block and two unique indexes; the schema check passes.

- [ ] **Step 7: Run the db tests** (the sqlite contract and the D1 snapshot)

Run: `corepack pnpm --filter @derive/db test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/ports.ts packages/db/src/schema.ts packages/db/src/pg-schema.ts packages/db/src/parity.ts deploy/d1-schema.sql
git commit -m "feat(db): workspace_join_link table and record types"
```

---

### Task 2: Store methods on both dialects

**Files:**
- Modify: `packages/core/src/ports.ts` (after `consumeInvitation`, around line 2299)
- Modify: `packages/db/src/repos.ts` (after `consumeInvitation`, around line 5022; and the returned object that lists methods)
- Modify: `packages/db/src/pg.ts` (after `consumeInvitation`, around line 6240)
- Test: `packages/db/test/store-contract.ts` (after the `invitation consumption` describe)

**Interfaces:**
- Consumes: `JoinLinkRecord`, `NewJoinLink`, `workspaceJoinLink` from Task 1.
- Produces, on `MetaStore`:
  - `getJoinLink(orgId: string): Promise<JoinLinkRecord | null>`
  - `getJoinLinkById(id: string): Promise<JoinLinkRecord | null>`
  - `getJoinLinkByToken(token: string): Promise<JoinLinkRecord | null>`
  - `replaceJoinLink(l: NewJoinLink): Promise<JoinLinkRecord>`
  - `deleteJoinLink(orgId: string): Promise<void>`
  - `recordJoin(id: string): Promise<void>`

- [ ] **Step 1: Write the failing contract test** (in `store-contract.ts`, after the `invitation consumption` block)

```ts
  describe(`${label}: workspace join link`, () => {
    it("keeps one link per workspace, rotates by replacing, counts joins, and revokes", async () => {
      const orgId = `join_org_${uuid()}`
      await store.setWorkspace(orgId, "Join Link Contract")
      const future = new Date(Date.now() + 60_000).toISOString()
      await expect(store.getJoinLink(orgId)).resolves.toBeNull()

      const first = await store.replaceJoinLink({
        id: `wjl_${uuid()}`,
        org_id: orgId,
        role: "editor",
        token: `dkj_${uuid()}`,
        created_by: null,
        expires_at: future,
      })
      expect(first.join_count).toBe(0)
      await expect(store.getJoinLinkById(first.id)).resolves.toMatchObject({ org_id: orgId })
      await expect(store.getJoinLinkByToken(first.token)).resolves.toMatchObject({
        id: first.id,
        role: "editor",
      })

      await store.recordJoin(first.id)
      await store.recordJoin(first.id)
      expect((await store.getJoinLink(orgId))?.join_count).toBe(2)

      // Rotating replaces the row: the old token stops resolving the moment the new one exists.
      const second = await store.replaceJoinLink({
        id: `wjl_${uuid()}`,
        org_id: orgId,
        role: "commenter",
        token: `dkj_${uuid()}`,
        created_by: null,
        expires_at: future,
      })
      expect(second.id).not.toBe(first.id)
      await expect(store.getJoinLinkByToken(first.token)).resolves.toBeNull()
      expect((await store.getJoinLink(orgId))?.role).toBe("commenter")

      await store.deleteJoinLink(orgId)
      await expect(store.getJoinLink(orgId)).resolves.toBeNull()
      await expect(store.getJoinLinkByToken(second.token)).resolves.toBeNull()
      // Revoking a workspace without a link is a no-op, not an error.
      await expect(store.deleteJoinLink(orgId)).resolves.toBeUndefined()
    })
  })
```

- [ ] **Step 2: Run it to see it fail**

Run: `corepack pnpm --filter @derive/db test -- sqlite-store`
Expected: FAIL, `store.getJoinLink is not a function` (and a typecheck error until the port exists).

- [ ] **Step 3: Add the port methods** (ports.ts, right after `consumeInvitation`)

```ts
  // ---- Workspace join link (one shareable link per workspace) --------------
  /** The workspace's current join link, or null when none exists. */
  getJoinLink(orgId: string): Promise<JoinLinkRecord | null>
  /** Resolve by id (the signup-admission capability carries the id, not the token). */
  getJoinLinkById(id: string): Promise<JoinLinkRecord | null>
  /** Resolve by its plaintext token (the join page reads this); null if unknown or revoked. */
  getJoinLinkByToken(token: string): Promise<JoinLinkRecord | null>
  /** Create the workspace's join link, replacing any existing one. Create and rotate are the
   *  same operation: the old token stops working the moment the new row exists. */
  replaceJoinLink(l: NewJoinLink): Promise<JoinLinkRecord>
  /** Revoke the workspace's join link. A no-op when none exists. */
  deleteJoinLink(orgId: string): Promise<void>
  /** Count one successful join through the link. */
  recordJoin(id: string): Promise<void>
```

- [ ] **Step 4: Implement in repos.ts** (after `consumeInvitation`; import `workspaceJoinLink` from `./schema` and make sure `sql` is imported from `drizzle-orm`; register every new const in the returned store object exactly where the invitation methods are listed)

```ts
  // ---- Workspace join link -------------------------------------------------
  const getJoinLink = async (orgId: string): Promise<JoinLinkRecord | null> =>
    (await db
      .select()
      .from(workspaceJoinLink)
      .where(eq(workspaceJoinLink.org_id, orgId))
      .get()) ?? null
  const getJoinLinkById = async (id: string): Promise<JoinLinkRecord | null> =>
    (await db.select().from(workspaceJoinLink).where(eq(workspaceJoinLink.id, id)).get()) ?? null
  const getJoinLinkByToken = async (token: string): Promise<JoinLinkRecord | null> =>
    (await db
      .select()
      .from(workspaceJoinLink)
      .where(eq(workspaceJoinLink.token, token))
      .get()) ?? null
  const replaceJoinLink = async (l: NewJoinLink): Promise<JoinLinkRecord> => {
    await db.delete(workspaceJoinLink).where(eq(workspaceJoinLink.org_id, l.org_id)).run()
    return (await db.insert(workspaceJoinLink).values(l).returning().get()) as JoinLinkRecord
  }
  const deleteJoinLink = async (orgId: string): Promise<void> => {
    await db.delete(workspaceJoinLink).where(eq(workspaceJoinLink.org_id, orgId)).run()
  }
  const recordJoin = async (id: string): Promise<void> => {
    await db
      .update(workspaceJoinLink)
      .set({ join_count: sql`${workspaceJoinLink.join_count} + 1` })
      .where(eq(workspaceJoinLink.id, id))
      .run()
  }
```

- [ ] **Step 5: Implement in pg.ts** (class methods after `consumeInvitation`; import `workspaceJoinLink` from `./pg-schema`, `JoinLinkRecord`/`NewJoinLink` from `@derive/core`)

```ts
  // ---- Workspace join link -------------------------------------------------
  async getJoinLink(orgId: string): Promise<JoinLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(workspaceJoinLink)
      .where(eq(workspaceJoinLink.org_id, orgId))
    return (rows[0] as JoinLinkRecord | undefined) ?? null
  }
  async getJoinLinkById(id: string): Promise<JoinLinkRecord | null> {
    const rows = await this.db.select().from(workspaceJoinLink).where(eq(workspaceJoinLink.id, id))
    return (rows[0] as JoinLinkRecord | undefined) ?? null
  }
  async getJoinLinkByToken(token: string): Promise<JoinLinkRecord | null> {
    const rows = await this.db
      .select()
      .from(workspaceJoinLink)
      .where(eq(workspaceJoinLink.token, token))
    return (rows[0] as JoinLinkRecord | undefined) ?? null
  }
  async replaceJoinLink(l: NewJoinLink): Promise<JoinLinkRecord> {
    await this.db.delete(workspaceJoinLink).where(eq(workspaceJoinLink.org_id, l.org_id))
    const rows = await this.db.insert(workspaceJoinLink).values(l).returning()
    return one(rows) as JoinLinkRecord
  }
  async deleteJoinLink(orgId: string): Promise<void> {
    await this.db.delete(workspaceJoinLink).where(eq(workspaceJoinLink.org_id, orgId))
  }
  async recordJoin(id: string): Promise<void> {
    await this.db
      .update(workspaceJoinLink)
      .set({ join_count: sql`${workspaceJoinLink.join_count} + 1` })
      .where(eq(workspaceJoinLink.id, id))
  }
```

- [ ] **Step 6: Typecheck and run the contract**

Run: `corepack pnpm --filter @derive/db typecheck && corepack pnpm --filter @derive/db test`
Expected: PASS (sqlite runs the contract; the D1 test needs its own config and is not part of `test`).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/ports.ts packages/db/src/repos.ts packages/db/src/pg.ts packages/db/test/store-contract.ts
git commit -m "feat(db): join link store methods on sqlite and postgres"
```

---

### Task 3: API routes, signup admission, tests, regenerated OpenAPI types

**Files:**
- Create: `apps/api/src/lib/join-link.ts`
- Create: `apps/api/src/routes/workspace-join.ts`
- Modify: `apps/api/src/lib/signup-policy.ts`
- Modify: `apps/api/src/app.ts` (import + the router list after `workspaceRoutes`)
- Test: `apps/api/test/join-link.test.ts` (new), `apps/api/test/signup-policy.test.ts` (one case)
- Regenerate: `apps/api/openapi.json`, `apps/web/src/api-types.ts`

**Interfaces:**
- Consumes: the six store methods from Task 2; `requireWorkspace`, `requireUser`, `currentUser`, `seatGrantGate` from `AppContext`; `mintToken` from `../lib/crypto`; `syncSeats` from `../lib/seats`; `roleEnum` from `../schemas`; `armInviteAdmission` from `../lib/signup-policy`.
- Produces: OpenAPI schemas `WorkspaceJoinLink` `{id, role, url, created_at, expires_at, join_count}`, `JoinLinkPreview` `{workspace, role, inviter, expires_at}`, `JoinResult` `{org_id, role, already_member}`; routes `GET|POST|DELETE /v1/workspace/join-link`, `GET|POST /v1/join/{token}`.

- [ ] **Step 1: Write the failing route tests** (`apps/api/test/join-link.test.ts`)

```ts
import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// The workspace join link: one shareable URL per workspace. Anyone who opens it joins at the
// link's role. Owner-only to create, revocable, 30-day expiry, never grants owner.
describe("workspace join link", () => {
  const admin: TestUser = { id: "u_jl_admin", email: "jladmin@derive.test", name: "Ada" }
  const teammate: TestUser = { id: "u_jl_mate", email: "jlmate@derive.test", name: "Mo" }
  const outsider: TestUser = { id: "u_jl_out", email: "jlout@derive.test", name: "Sam" }
  const second: TestUser = { id: "u_jl_two", email: "jltwo@derive.test", name: "Tia" }
  const { app } = makeAuthedApp("join_link", [admin, teammate, outsider, second], "editor", {
    isolated: true,
  })

  const create = (headers: Record<string, string>, body: unknown = {}) =>
    app.request("/v1/workspace/join-link", { ...jsonAs(headers, body), method: "POST" })
  const tokenOf = (link: { url: string }) => link.url.split("/join/")[1]
  const join = (token: string, headers?: Record<string, string>) =>
    app.request(`/v1/join/${token}`, { method: "POST", headers })

  it("creates a Creator link by default, and GET returns it without a 500 for 'none'", async () => {
    expect((await app.request("/v1/workspace/join-link", { headers: as(admin.email) })).status).toBe(
      404,
    )
    const res = await create(as(admin.email))
    expect(res.status).toBe(201)
    const link = await res.json()
    expect(link.role).toBe("editor")
    expect(link.url).toContain("/join/dkj_")
    expect(link.join_count).toBe(0)
    const got = await (await app.request("/v1/workspace/join-link", { headers: as(admin.email) })).json()
    expect(got.id).toBe(link.id)
    expect(got.url).toBe(link.url)
  })

  it("never grants owner, and accepts commenter explicitly", async () => {
    expect((await create(as(admin.email), { role: "owner" })).status).toBe(400)
    const res = await create(as(admin.email), { role: "commenter" })
    expect(res.status).toBe(201)
    expect((await res.json()).role).toBe("commenter")
  })

  it("rejects a non-owner creating, reading, or revoking the link", async () => {
    // Make teammate a Creator (member, not Admin) first.
    const add = await app.request("/v1/workspace/members", {
      ...jsonAs(as(admin.email), { email: teammate.email, role: "editor" }),
      method: "PUT",
    })
    expect(add.status).toBe(201)
    expect((await create(as(teammate.email))).status).toBe(403)
    expect(
      (await app.request("/v1/workspace/join-link", { headers: as(teammate.email) })).status,
    ).toBe(403)
    expect(
      (await app.request("/v1/workspace/join-link", { method: "DELETE", headers: as(teammate.email) }))
        .status,
    ).toBe(403)
  })

  it("previews without auth, joins the signed-in holder at the link's role, and counts the join", async () => {
    const link = await (await create(as(admin.email), { role: "editor" })).json()
    const token = tokenOf(link)
    const preview = await app.request(`/v1/join/${token}`)
    expect(preview.status).toBe(200)
    const p = await preview.json()
    expect(p.role).toBe("editor")
    expect(p.workspace).toBeTruthy()
    expect(p.inviter).toBe("Ada")

    const res = await join(token, as(outsider.email))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.role).toBe("editor")
    expect(body.already_member).toBe(false)
    const w = await (await app.request("/v1/workspace", { headers: as(admin.email) })).json()
    expect(w.members.some((m: { user_id: string }) => m.user_id === outsider.id)).toBe(true)
    const got = await (await app.request("/v1/workspace/join-link", { headers: as(admin.email) })).json()
    expect(got.join_count).toBe(1)

    // Joining again is idempotent: 200, already_member, no role change, no second count.
    const again = await (await join(token, as(outsider.email))).json()
    expect(again.already_member).toBe(true)
    expect(again.role).toBe("editor")
    const gotAgain = await (
      await app.request("/v1/workspace/join-link", { headers: as(admin.email) })
    ).json()
    expect(gotAgain.join_count).toBe(1)
  })

  it("never downgrades an existing member", async () => {
    // admin is the owner; a Viewer link must not touch their role.
    const link = await (await create(as(admin.email), { role: "commenter" })).json()
    const res = await (await join(tokenOf(link), as(admin.email))).json()
    expect(res.already_member).toBe(true)
    expect(res.role).toBe("owner")
  })

  it("rotates on re-create: the old token stops working", async () => {
    const first = await (await create(as(admin.email))).json()
    const second_ = await (await create(as(admin.email))).json()
    expect(second_.url).not.toBe(first.url)
    expect((await app.request(`/v1/join/${tokenOf(first)}`)).status).toBe(404)
    expect((await app.request(`/v1/join/${tokenOf(second_)}`)).status).toBe(200)
  })

  it("revokes: preview and join both 404 afterwards", async () => {
    const link = await (await create(as(admin.email))).json()
    const del = await app.request("/v1/workspace/join-link", {
      method: "DELETE",
      headers: as(admin.email),
    })
    expect(del.status).toBe(204)
    expect((await app.request(`/v1/join/${tokenOf(link)}`)).status).toBe(404)
    expect((await join(tokenOf(link), as(second.email))).status).toBe(404)
  })

  it("requires sign-in to join (anon is refused by the write lockdown)", async () => {
    const link = await (await create(as(admin.email))).json()
    const res = await app.request(`/v1/join/${tokenOf(link)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(403)
  })

  it("never leaks a link through the workspace roster or the pending-invite list", async () => {
    await create(as(admin.email))
    const list = await (await app.request("/v1/workspace/invites", { headers: as(admin.email) })).json()
    expect(JSON.stringify(list)).not.toContain("dkj_")
  })
})
```

Expiry (410) is exercised at the store level plus a direct unit of `isLiveJoinLink` in this same file:

```ts
import { isLiveJoinLink, JOIN_LINK_TTL_MS } from "../src/lib/join-link"

describe("join link liveness", () => {
  it("is live until expires_at, and the TTL is 30 days", () => {
    expect(JOIN_LINK_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000)
    expect(isLiveJoinLink({ expires_at: new Date(Date.now() + 1000).toISOString() })).toBe(true)
    expect(isLiveJoinLink({ expires_at: new Date(Date.now() - 1000).toISOString() })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `corepack pnpm --filter @derive/api test -- join-link`
Expected: FAIL (404s where 201 is expected; the lib import fails to resolve).

- [ ] **Step 3: Create `apps/api/src/lib/join-link.ts`**

```ts
import type { JoinLinkRecord, Role } from "@derive/core"

/** How long a workspace join link lives. Fixed; rotating the link is the only extension. */
export const JOIN_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/** A link is redeemable until its expiry. It is never "consumed": many people join through it. */
export const isLiveJoinLink = (l: { expires_at: string }): boolean =>
  new Date(l.expires_at).getTime() >= Date.now()

/** The roles a join link may grant. Never owner: an Admin link could take the workspace over. */
export type JoinLinkRole = Extract<Role, "commenter" | "editor">
export const isJoinLinkRole = (v: unknown): v is JoinLinkRole => v === "commenter" || v === "editor"

/** The link as the Admin sees it. The token rides only inside `url`. */
export const joinLinkJson = (l: JoinLinkRecord, url: string) => ({
  id: l.id,
  role: l.role,
  url,
  created_at: l.created_at,
  expires_at: l.expires_at,
  join_count: l.join_count,
})
```

- [ ] **Step 4: Create `apps/api/src/routes/workspace-join.ts`**

```ts
import { newId } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { mintToken } from "../lib/crypto"
import { bail, DEFAULT_WORKSPACE_NAME, fail, readJson } from "../lib/http"
import {
  isJoinLinkRole,
  isLiveJoinLink,
  JOIN_LINK_TTL_MS,
  type JoinLinkRole,
  joinLinkJson,
} from "../lib/join-link"
import { syncSeats } from "../lib/seats"
import { armInviteAdmission } from "../lib/signup-policy"
import { roleEnum } from "../schemas"

/** The workspace join link: ONE shareable URL per workspace that lets anyone who opens it
 *  join at the link's role (Creator or Viewer, never Admin). Admin-managed, revocable, 30-day
 *  expiry, seat-gated at join exactly like an email invite. The WorkspaceJoinLink /
 *  JoinLinkPreview / JoinResult schemas are the single source for the web client's types. */
export const workspaceJoinRoutes = (ctx: AppContext) => {
  const { meta, deps, requireUser, currentUser, requireWorkspace, seatGrantGate } = ctx
  const billing = deps.billing
  const app = new OpenAPIHono<BlankEnv>()

  const WorkspaceJoinLink = z
    .object({
      id: z.string(),
      role: roleEnum.describe("The role a joiner receives: commenter (Viewer) or editor (Creator)."),
      url: z.string().describe("The shareable URL. The token rides only here."),
      created_at: z.string(),
      expires_at: z.string().describe("Fixed 30 days from creation; rotate to extend."),
      join_count: z.number().int().describe("How many people have joined through this link."),
    })
    .openapi("WorkspaceJoinLink")

  const JoinLinkPreview = z
    .object({
      workspace: z.string(),
      role: roleEnum,
      inviter: z.string().nullable().describe("Display name of the Admin who made the link."),
      expires_at: z.string(),
    })
    .openapi("JoinLinkPreview")

  const JoinResult = z
    .object({
      org_id: z.string(),
      role: roleEnum.describe("The caller's role in the workspace after the call."),
      already_member: z
        .boolean()
        .describe("True when the caller was already a member; their role is never changed."),
    })
    .openapi("JoinResult")

  const urlFor = (token: string) => `${deps.baseUrl.replace(/\/$/, "")}/join/${token}`

  // ---- Admin side: the workspace's one link ------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspace/join-link",
      tags: ["Workspace"],
      summary: "The workspace's join link (Admin only); 404 when none exists.",
      responses: {
        200: {
          description: "The current link.",
          content: { "application/json": { schema: WorkspaceJoinLink } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const link = await meta.getJoinLink(org)
      if (!link) return bail(fail(c, 404, "this workspace has no join link"))
      return c.json(joinLinkJson(link, urlFor(link.token)))
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspace/join-link",
      tags: ["Workspace"],
      summary: "Create the workspace's join link, or rotate it (Admin only).",
      responses: {
        201: {
          description: "The fresh link. Any previous link stops working.",
          content: { "application/json": { schema: WorkspaceJoinLink } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const b = await readJson(
        c,
        z.object({
          role: z
            .custom<JoinLinkRole>(isJoinLinkRole, "role must be commenter or editor")
            .optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      // Creator by default: an activated team is one where members publish, and Viewers can't.
      const role: JoinLinkRole = b.role ?? "editor"
      const me = await currentUser(c)
      const link = await meta.replaceJoinLink({
        id: newId("wjl"),
        org_id: org,
        role,
        token: mintToken("dkj"),
        created_by: me?.id ?? null,
        expires_at: new Date(Date.now() + JOIN_LINK_TTL_MS).toISOString(),
      })
      return c.json(joinLinkJson(link, urlFor(link.token)), 201)
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/workspace/join-link",
      tags: ["Workspace"],
      summary: "Revoke the workspace's join link (Admin only).",
      responses: { 204: { description: "Revoked (or there was none)." } },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      await meta.deleteJoinLink(org)
      return c.body(null, 204)
    },
  )

  // ---- Joiner side: the link itself --------------------------------------
  // Preview: the token IS the secret (possession authorizes), so no auth. A valid preview arms
  // signup admission so a brand-new person can create an account on an invite-only instance.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/join/{token}",
      tags: ["Workspace"],
      summary: "Preview a join link (the join page reads this).",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "The workspace and role the link grants.",
          content: { "application/json": { schema: JoinLinkPreview } },
        },
      },
    }),
    async (c) => {
      const link = await meta.getJoinLinkByToken(c.req.param("token"))
      if (!link) return bail(fail(c, 404, "this join link is invalid or has been revoked"))
      if (!isLiveJoinLink(link))
        return bail(fail(c, 410, "this join link has expired", { code: "join_link_expired" }))
      await armInviteAdmission(c, "join", link.id, link.expires_at, deps.encryptionKey, {
        baseUrl: deps.baseUrl,
        crossSite: deps.crossSite,
      })
      const ws = await meta.getWorkspace(link.org_id)
      const inviter = link.created_by ? (await meta.getUsers([link.created_by]))[0] : undefined
      return c.json({
        workspace: ws?.name ?? DEFAULT_WORKSPACE_NAME,
        role: link.role,
        inviter: inviter?.name ?? null,
        expires_at: link.expires_at,
      })
    },
  )

  // Join: the signed-in holder becomes a member at the link's role. Idempotent for members
  // (never a downgrade); the same seat gate as an email invite for a Creator link.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/join/{token}",
      tags: ["Workspace"],
      summary: "Join the workspace through its link (signed-in holder).",
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "The workspace joined and the caller's role in it.",
          content: { "application/json": { schema: JoinResult } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const link = await meta.getJoinLinkByToken(c.req.param("token"))
      if (!link) return bail(fail(c, 404, "this join link is invalid or has been revoked"))
      if (!isLiveJoinLink(link))
        return bail(fail(c, 410, "this join link has expired", { code: "join_link_expired" }))
      const existing = await meta.getMembership(link.org_id, me.id)
      if (existing) return c.json({ org_id: link.org_id, role: existing.role, already_member: true })
      const gated = await seatGrantGate(c, link.org_id, link.role)
      if (gated) return bail(gated)
      await meta.setMembership({
        id: newId("m"),
        org_id: link.org_id,
        user_id: me.id,
        role: link.role,
      })
      await syncSeats({ meta, billing }, link.org_id)
      await meta.recordJoin(link.id)
      return c.json({ org_id: link.org_id, role: link.role, already_member: false })
    },
  )

  return app
}
```

If `fail` refuses the 410 status type, widen the status union in `apps/api/src/lib/http.ts` to include `410` (it is a `ContentfulStatusCode`); do not fall back to 404 for expiry.

- [ ] **Step 5: Mount it in `apps/api/src/app.ts`**: add `import { workspaceJoinRoutes } from "./routes/workspace-join"` next to the `workspaceRoutes` import, and `workspaceJoinRoutes,` right after `workspaceRoutes,` in the router list (around line 456).

- [ ] **Step 6: Teach signup admission the `join` kind** (`apps/api/src/lib/signup-policy.ts`)

Change the kind type and the policy body:

```ts
export type InviteKind = "workspace" | "artifact" | "collection" | "join"
```

```ts
export function signupPolicy(
  mode: SignupMode,
  secret: string,
  meta: Pick<MetaStore, "getInvitationByToken" | "getArtifactInviteByToken"> &
    Partial<Pick<MetaStore, "getCollectionInviteByToken" | "getJoinLinkById">>,
): (attempt: SignupAttempt) => Promise<boolean> {
  return async ({ cookieHeader }) => {
    if (mode === "open") return true
    if (mode === "closed") return false
    const encoded = cookieFromHeader(cookieHeader, ADMISSION_COOKIE)
    if (!encoded) return false
    const verified = await verifyCapabilityToken(ADMISSION_DOMAIN, secret, encoded, Date.now())
    if (!verified) return false
    const [kind, ref, extra] = verified.rest.split(".")
    if (extra !== undefined) return false
    // A join link's capability carries the link's ID, not a token hash: the link is multi-use
    // and its token is plaintext, so "still live" means the row still exists and hasn't expired.
    if (kind === "join") {
      if (!/^wjl_[a-z0-9]{1,64}$/.test(ref ?? "")) return false
      const link = await meta.getJoinLinkById?.(ref ?? "")
      return !!link && Date.parse(link.expires_at) > Date.now()
    }
    if (!/^[0-9a-f]{64}$/.test(ref ?? "")) return false
    const invite =
      kind === "workspace"
        ? await meta.getInvitationByToken(ref ?? "")
        : kind === "artifact"
          ? await meta.getArtifactInviteByToken(ref ?? "")
          : kind === "collection"
            ? await meta.getCollectionInviteByToken?.(ref ?? "")
            : null
    return !!invite && invite.accepted_at === null && Date.parse(invite.expires_at) > Date.now()
  }
}
```

`newId("wjl")` renders `wjl_<base36><base36>` (see `packages/core/src/ids.ts`), so the regex `^wjl_[a-z0-9]{1,64}$` matches it.

Add one case to `apps/api/test/signup-policy.test.ts`, next to the live-invite case, using the same `SECRET`:

```ts
  it("admits a signup armed by a live join link, and refuses it once the link is revoked", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    let link: { expires_at: string } | null = { expires_at: expiresAt }
    const allowed = signupPolicy("invite", SECRET, {
      getInvitationByToken: async () => null,
      getArtifactInviteByToken: async () => null,
      getJoinLinkById: async (id) => (id === "wjl_abc123" && link ? (link as never) : null),
    })
    const minted = await mintInviteAdmission("join", "wjl_abc123", expiresAt, SECRET)
    const cookieHeader = `${ADMISSION_COOKIE}=${encodeURIComponent(minted?.token ?? "")}`
    await expect(allowed({ email: "new@example.com", cookieHeader })).resolves.toBe(true)
    link = null // revoked
    await expect(allowed({ email: "new@example.com", cookieHeader })).resolves.toBe(false)
  })
```

- [ ] **Step 7: Run the api tests for the touched files**

Run: `corepack pnpm --filter @derive/api test -- join-link signup-policy invitations workspace`
Expected: PASS.

- [ ] **Step 8: Regenerate OpenAPI and the web types, then typecheck the api**

Run: `corepack pnpm --filter @derive/api gen:openapi && corepack pnpm --filter @derive/web gen:api-types && node scripts/check-api-types.mjs && corepack pnpm --filter @derive/api typecheck`
Expected: `apps/api/openapi.json` gains the five paths and three schemas; the check passes; typecheck passes (both tsconfigs).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/lib/join-link.ts apps/api/src/routes/workspace-join.ts apps/api/src/lib/signup-policy.ts apps/api/src/app.ts apps/api/test/join-link.test.ts apps/api/test/signup-policy.test.ts apps/api/openapi.json apps/web/src/api-types.ts
git commit -m "feat(api): workspace join link routes and join-kind signup admission"
```

---

### Task 4: Seat gate through the link

**Files:**
- Test: `apps/api/test/billing-seats.test.ts` (after the "4th-editor invite to an unknown email" case)

- [ ] **Step 1: Add the two cases**

```ts
  it("enforced: a Creator join link 402s on the 4th billable seat; a Viewer link never gates", async () => {
    const { app, meta } = makeAuthedApp("sg_join_link", [u(1), u(2), u(3), u(4), u(5)], "editor", {
      isolated: true,
      deps: { billing: new FakeBilling(), billingEnforceAt: PAST },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })

    const creator = await (
      await app.request("/v1/workspace/join-link", {
        ...jsonAs(as("u1@x.test"), { role: "editor" }),
        method: "POST",
      })
    ).json()
    const blocked = await app.request(`/v1/join/${creator.url.split("/join/")[1]}`, {
      method: "POST",
      headers: as("u4@x.test"),
    })
    expect(blocked.status).toBe(402)
    const body = await blocked.json()
    expect(body.code).toBe("billing_required")
    expect(body.error).toContain("/settings/billing")
    // Nobody joined, nothing counted.
    const w = await (await app.request("/v1/workspace", { headers: as("u1@x.test") })).json()
    expect(w.members.some((m: { user_id: string }) => m.user_id === "u4")).toBe(false)

    // A Viewer link is never a seat: the same person joins as a commenter.
    const viewer = await (
      await app.request("/v1/workspace/join-link", {
        ...jsonAs(as("u1@x.test"), { role: "commenter" }),
        method: "POST",
      })
    ).json()
    const ok = await app.request(`/v1/join/${viewer.url.split("/join/")[1]}`, {
      method: "POST",
      headers: as("u5@x.test"),
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()).role).toBe("commenter")
  })

  it("subscribed: a Creator join bumps the Stripe quantity like an invite does", async () => {
    const fake = new FakeBilling()
    const { app, meta } = makeAuthedApp("sg_join_link_sub", [u(1), u(2), u(3), u(4)], "editor", {
      isolated: true,
      deps: { billing: fake, billingEnforceAt: PAST },
    })
    await meta.setWorkspace("default", DEFAULT_WORKSPACE_NAME)
    await meta.setMembership({ id: "m_u1", org_id: "default", user_id: "u1", role: "owner" })
    await meta.setMembership({ id: "m_u2", org_id: "default", user_id: "u2", role: "editor" })
    await meta.setMembership({ id: "m_u3", org_id: "default", user_id: "u3", role: "editor" })
    await meta.upsertSubscription(subscriptionRow({ quantity: 3 }))
    const link = await (
      await app.request("/v1/workspace/join-link", {
        ...jsonAs(as("u1@x.test"), { role: "editor" }),
        method: "POST",
      })
    ).json()
    const r = await app.request(`/v1/join/${link.url.split("/join/")[1]}`, {
      method: "POST",
      headers: as("u4@x.test"),
    })
    expect(r.status).toBe(200)
    expect(fake.quantityCalls.at(-1)).toEqual({ subscriptionId: "sub_1", quantity: 4 })
  })
```

- [ ] **Step 2: Run**

Run: `corepack pnpm --filter @derive/api test -- billing-seats`
Expected: PASS. If the first case fails with 200, the seat gate is not wired into the join route; fix the route, not the test.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/billing-seats.test.ts
git commit -m "test(api): seat gate and Stripe sync through the join link"
```

---

### Task 5: Web client, query, and the pure copy helpers

**Files:**
- Modify: `apps/web/src/api.ts` (types near line 274; methods after `revokeWorkspaceInvite`)
- Modify: `apps/web/src/lib/queries.ts` (after `workspaceInvitesQuery`)
- Create: `apps/web/src/pages/settings/join-link-copy.ts`
- Test: `apps/web/src/pages/settings/join-link-copy.test.ts`

**Interfaces:**
- Consumes: generated `components["schemas"]["WorkspaceJoinLink" | "JoinLinkPreview" | "JoinResult"]` from Task 3; `unitPrice`, `PLANS` from `./billing-plans`.
- Produces: `api.getJoinLink(): Promise<WorkspaceJoinLink | null>`, `api.createJoinLink(role: "commenter" | "editor"): Promise<WorkspaceJoinLink>`, `api.revokeJoinLink(): Promise<void>`, `api.previewJoinLink(token): Promise<JoinLinkPreview>`, `api.joinWorkspace(token): Promise<JoinResult>`; `workspaceJoinLinkQuery()`; `joinLinkSeatLine(billing, role)`, `joinLinkActiveLine(billing)`, `joinLinkConfirmTitle`, `joinLinkConfirmDescription(billing, workspace)`.

- [ ] **Step 1: Write the failing copy test** (`join-link-copy.test.ts`)

```ts
import { describe, expect, it } from "vitest"
import {
  joinLinkActiveLine,
  joinLinkConfirmDescription,
  joinLinkConfirmTitle,
  joinLinkSeatLine,
} from "./join-link-copy"

const free = { tier: "free" as const, interval: null, subscribed: false, beta: false }
const team = { tier: "team" as const, interval: "month" as const, subscribed: true, beta: false }
const teamAnnual = { tier: "team" as const, interval: "year" as const, subscribed: true, beta: false }
const business = { tier: "business" as const, interval: "month" as const, subscribed: true, beta: false }
const beta = { ...free, beta: true }

describe("join link copy", () => {
  it("tells a free workspace that a 4th Creator moves everyone onto Team billing", () => {
    expect(joinLinkSeatLine(free, "editor")).toBe(
      "Free covers 3 Creators. A 4th moves you to Team, where every Creator and Admin is $15/mo.",
    )
  })
  it("tells a Team workspace that every Creator and Admin already bills", () => {
    expect(joinLinkSeatLine(team, "editor")).toBe(
      "Every Creator and Admin is $15/mo. Each join adds one.",
    )
  })
  it("prices from the plan, so Business and annual read correctly", () => {
    expect(joinLinkSeatLine(business, "editor")).toContain("$30/mo")
    expect(joinLinkSeatLine(teamAnnual, "editor")).toContain("$12/mo")
  })
  it("says billing is off on a beta instance", () => {
    expect(joinLinkSeatLine(beta, "editor")).toBe(
      "Billing is off on this instance, so Creators stay free.",
    )
  })
  it("has no seat line for a Viewer link", () => {
    expect(joinLinkSeatLine(team, "commenter")).toBeNull()
    expect(joinLinkSeatLine(free, "commenter")).toBeNull()
  })
  it("keeps the live-link line and the confirm dialog on the same price", () => {
    expect(joinLinkActiveLine(team)).toBe("Each join adds a Creator at $15/mo.")
    expect(joinLinkConfirmTitle).toBe("Create a Creator link?")
    expect(joinLinkConfirmDescription(team, "Acme")).toBe(
      "Everyone who joins becomes a Creator and adds $15/mo to Acme's bill. Revoke the link any time.",
    )
  })
  it("falls back to the Team monthly price when billing is unknown", () => {
    expect(joinLinkSeatLine(undefined, "editor")).toContain("$15/mo")
    expect(joinLinkActiveLine(undefined)).toBe("Each join adds a Creator at $15/mo.")
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `corepack pnpm --filter @derive/web test -- join-link-copy`
Expected: FAIL, cannot resolve `./join-link-copy`.

- [ ] **Step 3: Create `join-link-copy.ts`**

```ts
import type { BillingInfo, Role } from "@/api"
import { PLANS, unitPrice } from "./billing-plans"

/** The slice of BillingInfo the copy depends on. `undefined` = not loaded yet. */
export type JoinLinkBilling = Pick<BillingInfo, "tier" | "interval" | "subscribed" | "beta"> | undefined

// The per-editor monthly price this workspace pays, or would pay: the live plan's unit when
// subscribed, else Team monthly (the plan a 4th Creator moves a free workspace onto).
const teamMonthly = (PLANS.find((p) => p.tier === "team") as { unit?: { month: number } })?.unit?.month ?? 15
const price = (b: JoinLinkBilling): string =>
  `$${b?.subscribed && b.tier !== "free" ? unitPrice(b.tier, b.interval) : teamMonthly}/mo`

/** The always-visible line under the role select (and beside a live Creator link) that states
 *  what a Creator costs. Null for a Viewer link: viewers never hold a seat. Billing is
 *  licensed on grant, so once on Team EVERY Creator and Admin bills, not only the ones past
 *  three; the Team line says so, the free line says what the 4th Creator does. */
export function joinLinkSeatLine(billing: JoinLinkBilling, role: Role): string | null {
  if (role !== "editor" && role !== "owner") return null
  if (billing?.beta) return "Billing is off on this instance, so Creators stay free."
  if (billing?.subscribed) return `Every Creator and Admin is ${price(billing)}. Each join adds one.`
  return `Free covers 3 Creators. A 4th moves you to Team, where every Creator and Admin is ${price(billing)}.`
}

/** Under a live Creator link. */
export const joinLinkActiveLine = (billing: JoinLinkBilling): string =>
  `Each join adds a Creator at ${price(billing)}.`

/** The seat-confirm dialog a subscribed workspace sees before a Creator link exists. */
export const joinLinkConfirmTitle = "Create a Creator link?"
export const joinLinkConfirmDescription = (billing: JoinLinkBilling, workspace: string): string =>
  `Everyone who joins becomes a Creator and adds ${price(billing)} to ${workspace}'s bill. Revoke the link any time.`
```

Check `unitPrice`'s real signature in `billing-plans.ts` (it takes `(tier, interval)`; if `tier` is typed `PaidTier`, narrow with `b.tier as PaidTier` after the `tier !== "free"` check).

- [ ] **Step 4: Run the copy test**

Run: `corepack pnpm --filter @derive/web test -- join-link-copy`
Expected: PASS.

- [ ] **Step 5: Add the client types and methods to `api.ts`**

Near the other invite types (line ~274):

```ts
export type WorkspaceJoinLink = components["schemas"]["WorkspaceJoinLink"]
export type JoinLinkPreview = components["schemas"]["JoinLinkPreview"]
export type JoinResult = components["schemas"]["JoinResult"]
```

After `revokeWorkspaceInvite`:

```ts
  // The workspace join link: one shareable URL per workspace, Admin-managed (see
  // routes/workspace-join.ts). getJoinLink resolves null when none exists (a 404 there is
  // a state, not a failure).
  getJoinLink: (): Promise<WorkspaceJoinLink | null> =>
    f("/v1/workspace/join-link", opts()).then((r) => (r.status === 404 ? null : j(r))),
  createJoinLink: (role: "commenter" | "editor"): Promise<WorkspaceJoinLink> =>
    f("/v1/workspace/join-link", opts({ role })).then(j),
  revokeJoinLink: (): Promise<void> =>
    f("/v1/workspace/join-link", { method: "DELETE", credentials: "include" }).then(() => undefined),
  // The join page: preview by token, then join (the signed-in holder becomes a member).
  previewJoinLink: (token: string): Promise<JoinLinkPreview> =>
    f(`/v1/join/${encodeURIComponent(token)}`, opts()).then(j),
  joinWorkspace: (token: string): Promise<JoinResult> =>
    f(`/v1/join/${encodeURIComponent(token)}`, opts({})).then(j),
```

`opts({})` sends a POST with an empty JSON body (the helper switches to POST whenever a body is passed).

- [ ] **Step 6: Add the query** (`queries.ts`, after `workspaceInvitesQuery`)

```ts
/** The workspace's join link, Admin-only; null when none exists. */
export const workspaceJoinLinkQuery = () =>
  queryOptions({
    queryKey: ["workspace", "join-link"] as const,
    queryFn: () => api.getJoinLink(),
  })
```

- [ ] **Step 7: Typecheck the web app**

Run: `corepack pnpm --filter @derive/web typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/lib/queries.ts apps/web/src/pages/settings/join-link-copy.ts apps/web/src/pages/settings/join-link-copy.test.ts
git commit -m "feat(web): join link client, query, and seat copy"
```

---

### Task 6: The Join link card in Settings → Members

**Files:**
- Create: `apps/web/src/pages/settings/join-link-card.tsx`
- Modify: `apps/web/src/pages/settings/members-section.tsx` (render `<JoinLinkCard />` for Admins, above `<PendingInvites />`)

**Interfaces:**
- Consumes: `api.getJoinLink/createJoinLink/revokeJoinLink`, `workspaceJoinLinkQuery`, `billingQuery`, `workspaceQuery`, the copy helpers, `roleLabel`/`WS_ROLES` from `./roles`, `ConfirmDialog`, `SettingsGroup`, `ListRow`, `Select*`, `Button`, `copyText`, `toast`, `useApiMutation`.
- Test ids (the e2e spec in Task 8 uses them): `join-link-role`, `join-link-create`, `join-link-seat-line`, `join-link-confirm-dialog`, `join-link-confirm-create`, `join-link-url`, `join-link-meta`, `join-link-copy`, `join-link-regenerate`, `join-link-revoke`, `join-link-revoke-confirm`.

- [ ] **Step 1: Create `join-link-card.tsx`**

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Role } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ListRow } from "@/components/shared/list-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"
import { copyText } from "@/lib/clipboard"
import { billingQuery, workspaceJoinLinkQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import {
  joinLinkActiveLine,
  joinLinkConfirmDescription,
  joinLinkConfirmTitle,
  joinLinkSeatLine,
} from "./join-link-copy"
import { roleLabel, WS_ROLES } from "./roles"

type LinkRole = "commenter" | "editor"

// The roles a link may grant: Creator and Viewer, never Admin. Creator first and default.
const LINK_ROLES = WS_ROLES.filter((r) => r.value === "editor" || r.value === "commenter")

const daysLeft = (expiresAt: string): number =>
  Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000)

// One shareable link for the whole workspace. Admin-only (the caller renders it for Admins).
// Create and Regenerate are the same server call; Revoke deletes. A Creator link on a
// subscribed workspace pauses on the seat-confirm dialog so the charge is acknowledged before
// the link exists; the seat line under the select says what a Creator costs at all times.
export function JoinLinkCard() {
  const qc = useQueryClient()
  const { data: link, isPending } = useQuery(workspaceJoinLinkQuery())
  const { data: billing } = useQuery(billingQuery())
  const { data: ws } = useQuery(workspaceQuery())
  const [role, setRole] = useState<LinkRole>("editor")
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)

  const create = useApiMutation({
    mutationFn: (r: LinkRole) => api.createJoinLink(r),
    onSuccess: async (created) => {
      qc.setQueryData(workspaceJoinLinkQuery().queryKey, created)
      const copied = await copyText(created.url, { error: null })
      toast.success(copied ? "Join link ready. Link copied." : "Join link ready.")
    },
  })
  const revoke = useApiMutation({
    mutationFn: () => api.revokeJoinLink(),
    onSuccess: () => qc.setQueryData(workspaceJoinLinkQuery().queryKey, null),
    success: "Join link revoked",
  })

  const requestCreate = (r: LinkRole) => {
    // A subscribed workspace bills every Creator: confirm before a Creator link exists.
    if (r === "editor" && billing?.subscribed) {
      setConfirmCreate(true)
      return
    }
    create.mutate(r)
  }

  if (isPending) return null

  const activeRole: LinkRole = link ? (link.role === "commenter" ? "commenter" : "editor") : role
  const seatLine = joinLinkSeatLine(billing, link ? link.role : role)

  return (
    <SettingsGroup
      title="Join link"
      description={
        link
          ? `Anyone who opens this link joins as a ${roleLabel(link.role)}.`
          : "One link for the whole team. Anyone who opens it joins at this role."
      }
    >
      {link ? (
        <ListRow
          data-testid="join-link-row"
          mono
          title={
            <input
              data-testid="join-link-url"
              readOnly
              value={link.url}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full bg-transparent font-mono text-sm text-foreground outline-none"
              aria-label="Join link URL"
            />
          }
          meta={
            <span data-testid="join-link-meta">
              {roleLabel(link.role)} ·{" "}
              {daysLeft(link.expires_at) > 0
                ? `expires in ${daysLeft(link.expires_at)} days`
                : "expired, regenerate to renew"}{" "}
              · {link.join_count} joined
            </span>
          }
          below={
            link.role === "editor" ? (
              <p data-testid="join-link-seat-line" className="text-sm text-muted-foreground">
                {joinLinkActiveLine(billing)}
              </p>
            ) : undefined
          }
          actions={
            <>
              <Button
                data-testid="join-link-copy"
                variant="ghost"
                size="sm"
                onClick={() => copyText(link.url, { success: "Join link copied" })}
              >
                Copy link
              </Button>
              <Button
                data-testid="join-link-regenerate"
                variant="ghost"
                size="sm"
                onClick={() => requestCreate(activeRole)}
                disabled={create.isPending}
              >
                Regenerate
              </Button>
              <Button
                data-testid="join-link-revoke"
                variant="destructive-ghost"
                size="sm"
                onClick={() => setConfirmRevoke(true)}
              >
                Revoke
              </Button>
            </>
          }
        />
      ) : (
        <div className="flex flex-col gap-2 py-3.5">
          <div className="flex items-center gap-2">
            <Select value={role} onValueChange={(v) => setRole(v as LinkRole)}>
              <SelectTrigger data-testid="join-link-role" aria-label="Role for people who join" className="w-32.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LINK_ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              data-testid="join-link-create"
              size="sm"
              onClick={() => requestCreate(role)}
              loading={create.isPending}
            >
              Create link
            </Button>
          </div>
          {seatLine && (
            <p data-testid="join-link-seat-line" className="text-sm text-muted-foreground">
              {seatLine}
            </p>
          )}
        </div>
      )}

      {confirmCreate && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirmCreate(false)}
          title={joinLinkConfirmTitle}
          description={joinLinkConfirmDescription(billing, ws?.name ?? "this workspace")}
          confirmLabel="Create link"
          tone="default"
          contentTestId="join-link-confirm-dialog"
          confirmTestId="join-link-confirm-create"
          onConfirm={() => {
            setConfirmCreate(false)
            create.mutate("editor")
          }}
        />
      )}
      {confirmRevoke && link && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirmRevoke(false)}
          title="Revoke the join link?"
          description="The link stops working immediately. People who already joined keep their seats."
          confirmLabel="Revoke"
          confirmTestId="join-link-revoke-confirm"
          onConfirm={() => {
            setConfirmRevoke(false)
            revoke.mutate()
          }}
        />
      )}
    </SettingsGroup>
  )
}
```

If `ListRow`'s `title` prop is typed `ReactNode` the `<input>` is fine; if `Button` has no `loading` prop in this codebase, use `disabled={create.isPending}` (check `apps/web/src/components/ui/button.tsx`; `accept-invite.tsx` uses `loading`, so it exists). Read `roles.ts` once more: `Role` there is the web `Role` type from `@/api`.

- [ ] **Step 2: Render it in `members-section.tsx`**: import `{ JoinLinkCard } from "./join-link-card"` and change `{isAdmin && <PendingInvites />}` to

```tsx
      {isAdmin && <JoinLinkCard />}
      {isAdmin && <PendingInvites />}
```

- [ ] **Step 3: Typecheck and lint**

Run: `corepack pnpm --filter @derive/web typecheck && corepack pnpm biome check apps/web/src/pages/settings`
Expected: PASS. Fix import order or formatting with `corepack pnpm biome check --write apps/web/src/pages/settings` if biome asks.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/settings/join-link-card.tsx apps/web/src/pages/settings/members-section.tsx
git commit -m "feat(web): join link card in workspace members settings"
```

---

### Task 7: The join page with auto-resume

**Files:**
- Modify: `apps/web/src/pages/accept-invite.tsx` (export `Shell` and `InvitationPanel`)
- Create: `apps/web/src/pages/join-workspace.tsx`
- Create: `apps/web/src/routes/join.$token.tsx`
- Regenerate: `apps/web/src/routeTree.gen.ts`

**Interfaces:**
- Consumes: `api.previewJoinLink`, `api.joinWorkspace`, `api.switchWorkspace`; `ApiError` from `@/api`; `useAuth` from `@/ctx`; `reloadAfterWorkspaceChange(target?)` from `@/lib/persist`; `Shell`, `InvitationPanel` from `./accept-invite`; `roleLabel` from `./settings/roles`.
- Produces: route `/join/$token` with search `{ go?: true }`.

- [ ] **Step 1: Export the two shared pieces from `accept-invite.tsx`**: change `function Shell(` to `export function Shell(` and `function InvitationPanel(` to `export function InvitationPanel(`. No other change.

- [ ] **Step 2: Create the route file `apps/web/src/routes/join.$token.tsx`**

```tsx
import { createFileRoute } from "@tanstack/react-router"
import { JoinWorkspace } from "../pages/join-workspace"

// Join a workspace through its shareable link. The token in the path is the secret
// (possession authorizes), so this route is reachable by anyone with the link; the page
// gates the join behind sign-in. Chrome-less, like /invite/$token. `?go=1` rides return_to
// through the auth hand-off so the join the person already asked for finishes without a
// second click (the /claim/$token pattern). A plain visit never joins anyone.
export const Route = createFileRoute("/join/$token")({
  validateSearch: (s: Record<string, unknown>) => ({
    ...(s.go === true || s.go === "1" || s.go === "true" ? { go: true } : {}),
  }),
  component: JoinWorkspace,
})
```

- [ ] **Step 3: Create the page `apps/web/src/pages/join-workspace.tsx`**

```tsx
import { useQuery } from "@tanstack/react-query"
import { getRouteApi, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { ApiError, api } from "@/api"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { reloadAfterWorkspaceChange } from "@/lib/persist"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { InvitationPanel, Shell } from "./accept-invite"
import { roleLabel } from "./settings/roles"

const route = getRouteApi("/join/$token")

// The join page behind a workspace's shareable link. Reuses the invitation panel: the
// only differences are that no email is bound (so no mismatch warning), that a signed-out
// visitor comes back with ?go=1 and the join finishes itself, and that a Creator link can
// be turned away by the seat gate.
export function JoinWorkspace() {
  useDocumentTitle("Join workspace")
  const { token } = route.useParams()
  const { go } = route.useSearch()
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const [seatLimited, setSeatLimited] = useState(false)

  const {
    data: preview,
    isPending,
    error,
  } = useQuery({
    queryKey: ["join-link", token],
    queryFn: () => api.previewJoinLink(token),
    retry: false,
    // Keyed by the join token (a capability secret): never write it to IndexedDB.
    meta: { persist: false },
  })

  const joinMut = useApiMutation({
    mutationFn: () => api.joinWorkspace(token),
    errorToast: false,
    onSuccess: async (r) => {
      // Land IN the workspace just joined: switch the active-workspace cookie, then the same
      // reload the workspace switcher uses (it drops the persisted query cache at boot so no
      // staleTime-Infinity query serves the previous workspace). The reload targets home.
      await api.switchWorkspace(r.org_id)
      reloadAfterWorkspaceChange("/")
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) return
      // A session that lapsed between load and click: finish sign-in, come back with ?go=1.
      if (err.status === 401) nav({ to: "/login", search: { return_to: `/join/${token}?go=1` } })
      // The seat gate: a Creator link on a workspace out of Creator seats.
      if (err.status === 402) setSeatLimited(true)
    },
  })

  const join = () => {
    // Not signed in: sign in (or create an account) and come back with ?go=1 so the join the
    // person just asked for finishes without a second click.
    if (!me) {
      nav({ to: "/login", search: { return_to: `/join/${token}?go=1` } })
      return
    }
    joinMut.mutate()
  }

  // Back from the auth hand-off: they already clicked once. A plain visit (no go) never joins.
  const fired = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot on (go, me, preview); joinMut is stable from useApiMutation
  useEffect(() => {
    if (!go || fired.current || !me || !preview) return
    fired.current = true
    joinMut.mutate()
  }, [go, me, preview])

  if (isPending || loading)
    return (
      <Shell>
        <Spinner />
      </Shell>
    )

  if (error || !preview) {
    const expired = error instanceof ApiError && error.status === 410
    return (
      <Shell>
        <StatusPanel
          tone="danger"
          title={expired ? "This link has expired" : "This link is invalid or has been revoked"}
          description={
            expired
              ? "Ask the person who sent it for a new one."
              : "Ask a workspace Admin for a new one."
          }
        />
        <Button variant="outline" data-testid="invite-go-home" onClick={() => nav({ to: "/" })}>
          Go to Derive
        </Button>
      </Shell>
    )
  }

  const inviter = preview.inviter ?? "the workspace Admin"
  return (
    <InvitationPanel
      heading={preview.inviter ? `${preview.inviter} invited you` : "You're invited"}
      body={
        <>
          <p className="text-sm text-pretty text-muted-foreground">
            Join <span className="font-medium text-foreground">{preview.workspace}</span> on Derive as{" "}
            <Badge variant="secondary">{roleLabel(preview.role)}</Badge>
          </p>
          {seatLimited && (
            <div data-testid="join-seat-limited" className="w-full">
              <StatusPanel
                tone="warning"
                layout="inline"
                title={`${preview.workspace} has no Creator seats left.`}
                description={`Ask ${inviter} for a Viewer link or an upgrade.`}
              />
            </div>
          )}
        </>
      }
      invitedEmail=""
      cta={{ idle: `Join ${preview.workspace}`, busy: "Joining…", signIn: "Sign in to join" }}
      signedIn={!!me}
      accepting={joinMut.isPending}
      err={seatLimited ? "" : (joinMut.error?.message ?? "")}
      mismatchEmail={null}
      onAccept={join}
    />
  )
}
```

`reloadAfterWorkspaceChange(target?)` lives in `apps/web/src/lib/persist.ts`; it flags the next boot to drop the persisted cache and hard-navigates to `target`. Raw `location.assign`/`location.reload` are banned in apps/web by `scripts/check-workspace-reload.mjs`, so always go through it.

- [ ] **Step 4: Regenerate the route tree and typecheck**

Run: `corepack pnpm --filter @derive/web build && git diff --stat apps/web/src/routeTree.gen.ts && corepack pnpm --filter @derive/web typecheck`
Expected: `routeTree.gen.ts` gains a `JoinTokenRoute` import and entries for `/join/$token`; typecheck passes. If the build does not regenerate the tree, run `corepack pnpm --filter @derive/web dev` for a few seconds and stop it; the plugin writes the file on start.

- [ ] **Step 5: Lint and commit**

Run: `corepack pnpm biome check apps/web/src/pages apps/web/src/routes`

```bash
git add apps/web/src/pages/accept-invite.tsx apps/web/src/pages/join-workspace.tsx 'apps/web/src/routes/join.$token.tsx' apps/web/src/routeTree.gen.ts
git commit -m "feat(web): /join/\$token page with auto-resume after sign-in"
```

---

### Task 8: End-to-end spec, docs, gates

**Files:**
- Create: `apps/web/e2e/join-link.smoke.spec.ts`
- Modify: `docs/access-model.md` (one paragraph after the "pending email invitations" sentence around line 101)
- Add: `docs/superpowers/specs/2026-09-10-workspace-join-link-design.md`, `docs/superpowers/plans/2026-09-10-workspace-join-link.md` (already written)

- [ ] **Step 1: Write the e2e spec** (the `owner` fixture is a signed-in first user, the workspace Admin; `page` is a fresh signed-out context)

```ts
import { expect, test } from "./fixtures"

// The workspace join link end to end: an Admin creates a Creator link in Settings, a second
// person opens it signed out, creates an account from the sign-in prompt, and lands in the
// workspace without clicking Join again (the ?go=1 auto-resume). The owner's card counts it.
test("a join link brings a new person into the workspace as a Creator", async ({ owner, page }) => {
  await owner.goto("/settings/members")
  await owner.getByTestId("join-link-create").click()
  const url = await owner.getByTestId("join-link-url").inputValue()
  expect(url).toContain("/join/dkj_")
  await expect(owner.getByTestId("join-link-meta")).toContainText("0 joined")

  // The second person, signed out, opens the link and is sent to sign in.
  await page.goto(new URL(url).pathname)
  await expect(page.getByTestId("invite-accept")).toHaveText("Sign in to join")
  await page.getByTestId("invite-accept").click()
  await expect(page).toHaveURL(/\/login\?.*return_to=/)

  // Create an account right there; return_to carries /join/<token>?go=1 through the hand-off.
  await page.getByTestId("login-toggle").click()
  await page.getByTestId("login-name").fill("Joiner")
  await page.getByTestId("login-email").fill(`e2e+join-${crypto.randomUUID()}@derive.test`)
  await page.getByTestId("login-password").fill("e2e-pass-1234")
  await page.getByTestId("login-submit").click()

  // Back on the join page with go=1 the join fires itself, then the app reloads into the
  // workspace. A fresh account may pass through /welcome first; skipping it must not lose the join.
  const skip = page.getByTestId("welcome-skip")
  if (await skip.isVisible({ timeout: 10_000 }).catch(() => false)) await skip.click()
  await expect(page.getByTestId("library-menu")).toBeVisible({ timeout: 20_000 })

  // The owner's card counts the join.
  await owner.reload()
  await expect(owner.getByTestId("join-link-meta")).toContainText("1 joined")
})
```

Run it once: `corepack pnpm --filter @derive/web test:e2e -- join-link` (Playwright's webServer boots the api and web; if browsers are missing, `corepack pnpm exec playwright install chromium` first). Adjust the post-signup assertions to the flow the run shows (the onboarding guard may land on `/welcome` before or after the join fires); the invariant to keep is that the second user ends up a member and the count reads `1 joined`. If the environment cannot run Playwright at all, say so in the PR body rather than deleting the spec.

- [ ] **Step 2: Document it in `docs/access-model.md`** (after the sentence ending "and copy-link action as an artifact.")

```markdown
A workspace may also carry **one join link** (`workspace_join_link`): anyone who opens
`/join/<token>` and signs in joins at the link's role, Creator or Viewer, never Admin. It
is Admin-managed, revocable, expires 30 days after creation, and a Creator link runs the
same seat gate as an email invite at join time. Its token is stored in plaintext by design
(a revocable, expiring, shareable secret the Admin must be able to copy again). In blast
radius it sits between a per-email invitation and a world link on an artifact.
```

- [ ] **Step 3: Run every gate**

```bash
corepack pnpm --filter @derive/core typecheck
corepack pnpm --filter @derive/db typecheck
corepack pnpm --filter @derive/api typecheck
corepack pnpm --filter @derive/web typecheck
corepack pnpm biome check .
node scripts/check-schema.mjs
node scripts/check-api-types.mjs
corepack pnpm -r test
```

Expected: all green. If `apps/api/test/mcp.test.ts` times out under coverage, re-run that file alone; it is the known flake, not this branch.

- [ ] **Step 4: Commit docs and the spec**

```bash
git add apps/web/e2e/join-link.smoke.spec.ts docs/access-model.md docs/superpowers/specs/2026-09-10-workspace-join-link-design.md docs/superpowers/plans/2026-09-10-workspace-join-link.md
git commit -m "docs: workspace join link spec, plan, access-model note, e2e"
```

- [ ] **Step 5: Whole-branch review, push, hand over**

Review `git diff origin/main...HEAD` against the spec: every route in section API exists, the copy matches Global Constraints word for word, owner is never grantable, the seat gate runs at join, the token is plaintext, the join page never joins on a plain visit. Then `git push -u origin feat/workspace-join-link` (the pre-push hook runs `pnpm verify`; if it fails on the known mcp flake, ask Connor to run `! git push --no-verify` himself). Paste the PR title and body inline in chat; do not attempt `gh pr create`.
