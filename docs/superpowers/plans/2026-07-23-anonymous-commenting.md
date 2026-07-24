# Anonymous Commenting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A logged-out visitor on an artifact whose link is set to "Can comment" (or better) can read comment threads and post comments/replies under a required self-provided display name, capped at commenter, rate-limited by IP, with anonymous comments visibly badged "guest".

**Architecture:** Open the two existing authorization gates narrowly (the `effectiveRole` anon clamp in `@derive/core` and the API's anonymous-write allow-list) rather than adding any new endpoint. The comment create handler already supports name-only authorship (`author` notNull, `author_id` nullable); we make that path reachable, require the name for anon, and stamp `meta.guest = true` at write time so guest rendering never misfires on legacy rows. The web composer gains a localStorage-backed name field driven through the existing actions context.

**Tech Stack:** TypeScript monorepo (pnpm), Hono + @hono/zod-openapi (API), Drizzle (SQLite + Postgres), Vitest, React + TanStack Query (web), Biome.

**Spec:** `docs/superpowers/specs/2026-07-23-anonymous-commenting-design.md`

## Global Constraints

- Branch: `feat/anon-commenting` (already created; spec committed).
- Anonymous NEVER exceeds `commenter` — even on an `editor` link.
- Anonymous can never edit/delete/resolve/react — only create.
- Private (`link_role="none"`) and viewer links: zero behavior change for anon.
- Password-locked artifacts: unlock still required before any link role applies (existing behavior, must not regress).
- No em dashes in any user-facing copy.
- Every new interactive control in `apps/web/src/pages/` needs a `data-testid` (`pnpm lint:testids` enforces).
- Run all test commands from the repo root `/Users/connor/Downloads/Claude/Derive/derive`.
- Commit format: conventional commits, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Core permissions — anon holder of a commenter+ link resolves to commenter

**Files:**
- Modify: `packages/core/src/permissions.ts` (the `effectiveRole` function and the doc comment above it)
- Test: `packages/core/test/permissions.test.ts`

**Interfaces:**
- Produces: `effectiveRole(actor, workspaceAccess, linkRole)` — unchanged signature; NEW behavior: for `actor.kind === "anon"`, `linkRole "commenter" | "editor"` yields `"commenter"` (was `"viewer"`). Every API `authorize()` call inherits this automatically.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/permissions.test.ts` (match the file's existing describe/it style — read the file first and place these in the existing `effectiveRole` describe block if one exists, else add one):

```ts
describe("anonymous commenter links", () => {
  const anon = { kind: "anon" as const, locked: false, unlocked: false }

  it("anon on a commenter link gets commenter", () => {
    expect(effectiveRole(anon, "none", "commenter")).toBe("commenter")
  })

  it("anon on an editor link is capped at commenter", () => {
    expect(effectiveRole(anon, "none", "editor")).toBe("commenter")
  })

  it("anon on a viewer link stays viewer", () => {
    expect(effectiveRole(anon, "none", "viewer")).toBe("viewer")
  })

  it("anon with no link gets nothing", () => {
    expect(effectiveRole(anon, "none", "none")).toBeNull()
  })

  it("anon on a locked commenter link gets nothing until unlocked", () => {
    const lockedAnon = { kind: "anon" as const, locked: true, unlocked: false }
    expect(effectiveRole(lockedAnon, "none", "commenter")).toBeNull()
    const unlockedAnon = { kind: "anon" as const, locked: true, unlocked: true }
    expect(effectiveRole(unlockedAnon, "none", "commenter")).toBe("commenter")
  })

  it("anon can comment but never edit/publish on an editor link", () => {
    expect(can(anon, "comment", "none", "editor")).toBe(true)
    expect(can(anon, "publish", "none", "editor")).toBe(false)
    expect(can(anon, "propose", "none", "editor")).toBe(true)
    expect(can(anon, "share", "none", "editor")).toBe(false)
  })

  it("signed-in holder still gets the link's full role", () => {
    const user = { kind: "user" as const, locked: false, unlocked: false }
    expect(effectiveRole(user, "none", "editor")).toBe("editor")
  })
})
```

Note: check the actual `Actor` type shape and `can()` signature in `permissions.ts` before writing — if `can()` takes `(actor, action, workspaceAccess, linkRole)` in a different order or `Actor` requires more fields (e.g. `artifactRole`), adapt the test calls to the real signatures. The behavioral assertions stay exactly as above.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @derive/core test -- permissions`
Expected: the three NEW-behavior tests fail (`commenter` expected, got `viewer`); the unchanged-behavior tests pass.

- [ ] **Step 3: Implement**

In `packages/core/src/permissions.ts`, `effectiveRole`, replace the `world` computation:

```ts
  // The world link: anyone with the URL. A password suspends it until unlocked.
  // A signed-in holder gets the link's role. An anonymous holder is capped at
  // commenter: a "can comment" (or better) link admits named guest comments,
  // but no anonymous caller ever holds a writing role past commenter.
  const world: Role | null =
    linkRole === "none"
      ? null
      : actor.locked && !actor.unlocked
        ? null
        : actor.kind === "user"
          ? linkRole
          : linkRole === "viewer"
            ? "viewer"
            : "commenter"
```

Also rewrite the invariant paragraph in the doc comment above the function (the block starting "Invariant: an anonymous caller is never more than `viewer`"):

```
 * Invariant: an anonymous caller is never more than `commenter`, and reaches
 * commenter only through an explicit commenter-or-better world link. Publish,
 * approve, share, and manage always need an authenticated identity. The old
 * rule ("anon is never more than viewer") was relaxed 2026-07 so external
 * reviewers can leave named guest comments on a "can comment" link.
```

And update the WORLD LINK bullet ("an anonymous holder is always clamped to `viewer`") to match: "a signed-in holder gets `linkRole`; an anonymous holder is capped at `commenter`."

- [ ] **Step 4: Run the full core suite**

Run: `pnpm --filter @derive/core test`
Expected: all pass. If an existing test asserts the old viewer clamp, update that assertion to the new rule (it is a deliberate behavior change, note it in the commit body).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/permissions.ts packages/core/test/permissions.test.ts
git commit -m "feat(core): anonymous holders of commenter+ links resolve to commenter

Relaxes the anon-is-never-more-than-viewer invariant to anon-is-never-
more-than-commenter, and only via an explicit commenter-or-better world
link. Editor links cap anonymous at commenter. Viewer/none links and
locked artifacts are unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: API — anonymous comment create with a required name + guest stamp

**Files:**
- Modify: `apps/api/src/app.ts` (ANON_WRITE_ALLOW)
- Modify: `apps/api/src/routes/comments.ts` (create handler)
- Test: `apps/api/test/anon-comments.test.ts` (new file)

**Interfaces:**
- Consumes: Task 1's `effectiveRole` change (route `authorize(c, "comment", artifact)` now passes for anon on commenter links).
- Produces: `POST /v1/artifacts/{shortId}/comments` reachable anonymously; anon requests require non-empty `body.author` (≤80 chars) → else 400 `"name required"`; created row has `author_id = null` and comment `meta` JSON containing `guest: true`. Task 5 exposes `guest` on the wire; Task 3 opens reads.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/anon-comments.test.ts`. Use the existing helpers: `app` (token-authed proxy), `anonApp` (the same app with NO auth — the anonymous caller), `json` (POST opts), `upload` (creates an artifact as the token owner). Look at `apps/api/test/helpers.ts` and `apps/api/test/comments.test.ts` first to confirm the exact call shapes.

```ts
import { describe, expect, it } from "vitest"
import { anonApp, app, json, upload } from "./helpers"

// Create an artifact and set its world link role; returns short_id.
const artifactWithLink = async (linkRole: "none" | "viewer" | "commenter" | "editor") => {
  const shortId = (
    await (await upload("doc.md", "# feedback me", { title: "Anon commenting" })).json()
  ).short_id as string
  const res = await app.request(`/v1/artifacts/${shortId}/access`, {
    ...json({ linkRole }),
    method: "PATCH",
  })
  expect(res.status).toBe(200)
  return shortId
}

describe("anonymous commenting", () => {
  it("anon can comment on a commenter link with a name", async () => {
    const shortId = await artifactWithLink("commenter")
    const res = await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "love this section", author: "Glen from Customer.io" }),
    )
    expect(res.status).toBe(201)
    const cm = await res.json()
    expect(cm.author).toBe("Glen from Customer.io")
  })

  it("anon without a name is rejected", async () => {
    const shortId = await artifactWithLink("commenter")
    for (const body of [{ body_md: "hi" }, { body_md: "hi", author: "" }, { body_md: "hi", author: "   " }]) {
      const res = await anonApp.request(`/v1/artifacts/${shortId}/comments`, json(body))
      expect(res.status).toBe(400)
    }
  })

  it("anon with an overlong name is rejected", async () => {
    const shortId = await artifactWithLink("commenter")
    const res = await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "hi", author: "x".repeat(81) }),
    )
    expect(res.status).toBe(400)
  })

  it("anon cannot comment on a viewer link", async () => {
    const shortId = await artifactWithLink("viewer")
    const res = await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "hi", author: "Guest" }),
    )
    expect(res.status).toBe(403)
  })

  it("anon cannot comment on a private artifact", async () => {
    const shortId = await artifactWithLink("none")
    const res = await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "hi", author: "Guest" }),
    )
    expect(res.status).toBe(403)
  })

  it("anon can comment on an editor link but never edit or delete", async () => {
    const shortId = await artifactWithLink("editor")
    const created = await (
      await anonApp.request(
        `/v1/artifacts/${shortId}/comments`,
        json({ body_md: "guest note", author: "Guest" }),
      )
    ).json()
    // Edit: PATCH is not on the anon allow-list -> 403 at the door.
    const edit = await anonApp.request(`/v1/artifacts/${shortId}/comments/${created.id}`, {
      ...json({ body_md: "hijacked" }),
      method: "PATCH",
    })
    expect(edit.status).toBe(403)
    const del = await anonApp.request(`/v1/artifacts/${shortId}/comments/${created.id}`, {
      ...json({}),
      method: "DELETE",
    })
    expect(del.status).toBe(403)
    const resolve = await anonApp.request(
      `/v1/artifacts/${shortId}/comments/${created.id}/resolve`,
      json({ state: "resolved" }),
    )
    expect(resolve.status).toBe(403)
  })

  it("signed-in callers ignore a body author (session name wins)", async () => {
    const shortId = await artifactWithLink("commenter")
    // `app` authenticates as the static-token owner; actingUser is null for a
    // token principal, so use the token path's documented behavior instead:
    // this guards the USER path via makeAuthedApp if available. Read
    // helpers.ts; if makeAuthedApp + as() provide a real user session, use:
    //   const res = await app2.request(..., jsonAs(as("u@x.co"), { body_md: "hi", author: "Spoof" }))
    //   expect((await res.json()).author).not.toBe("Spoof")
    // If that harness costs more than it earns here, assert the route code
    // directly in review instead and drop this case.
  })
})
```

The last test is a judgment call: implement it with `makeAuthedApp`/`as`/`jsonAs` if those helpers give a real signed-in user cheaply (they do in other suites — see `apps/api/test/comment-access.test.ts` for usage patterns); otherwise delete the stub before committing. Do not leave a commented-out test in the final diff.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @derive/api test -- anon-comments`
Expected: FAIL — the create cases return 403 (the anon lockdown), not 201/400.

- [ ] **Step 3: Implement — allow-list the create path**

In `apps/api/src/app.ts`, add to `ANON_WRITE_ALLOW` (keep the comment style of the neighboring entries):

```ts
    /^\/v1\/artifacts\/[^/]+\/comments$/, // guest comment create — role-gated in the route (commenter+ link required); create only, never edit/delete/resolve
```

The regex matches only the create path. `/comments/{id}` (PATCH/DELETE), `/comments/{id}/resolve`, and `/comments/{id}/react` do NOT match, so every other comment mutation still 403s at the door.

- [ ] **Step 4: Implement — require the name and stamp guest meta**

In `apps/api/src/routes/comments.ts` create handler, after `const acting = await actingUser(c)` and the existing `author` computation, replace the author block:

```ts
      const acting = await actingUser(c)
      // A signed-in author is always the session identity; a guest MUST name
      // themself (the UI requires it; the API enforces it). Names are display-
      // only — authorization never keys on them.
      const guestName = typeof body.author === "string" ? body.author.trim() : ""
      if (!acting && !guestName) return bail(fail(c, 400, "name required"))
      if (!acting && guestName.length > 80)
        return bail(fail(c, 400, "name is too long (max 80 characters)"))
      const author = acting ? acting.name : guestName
```

Then stamp the guest flag in meta at creation. The existing code persists mentions into meta after create; extend that block so a guest row always carries `guest: true` (find the `if (mentions.length)` block after `meta.createComment` and rework it):

```ts
      const metaPatch: Record<string, unknown> = {}
      if (mentions.length) metaPatch.mentions = mentions
      // Stamp guest authorship at write time: author_id is null for legacy
      // signed-in rows too, so rendering keys on this explicit flag instead.
      if (!acting) metaPatch.guest = true
      if (Object.keys(metaPatch).length) {
        const patched = await meta.updateComment(created.id, {
          meta: JSON.stringify({ ...parseMeta(created.meta), ...metaPatch }),
        })
        if (patched) created = patched
      }
```

Keep the existing surrounding logic (thread id, anchor cap, fan-out) untouched. `author_id: acting?.id ?? null` already does the right thing.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @derive/api test -- anon-comments`
Expected: PASS (all cases).
Also run: `pnpm --filter @derive/api test -- comments` and `pnpm --filter @derive/api test -- authz`
Expected: PASS. The authz-coverage suite asserts every mutating route is protected — if it flags the comments create path as newly anon-reachable, read its failure message and extend its expected-exceptions list the same way presence/unlock are listed, preserving the suite's intent.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/routes/comments.ts apps/api/test/anon-comments.test.ts
git commit -m "feat(api): anonymous guest comments on commenter links, named + stamped

Adds the comment-create path to the anonymous allow-list (create only;
edit/delete/resolve/react still refused at the door). Guests must send a
non-empty display name (max 80 chars); rows stamp meta.guest=true so
guest rendering never misfires on legacy null-author_id rows.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: API — anonymous commenters can read the threads they write into

**Files:**
- Modify: `apps/api/src/routes/comments.ts` (list route gate; check the single-thread/read routes for the same `anonLocked` pattern)
- Test: `apps/api/test/anon-comments.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 (anon `authorize(c, "comment", artifact)` is true on commenter+ links).
- Produces: `GET /v1/artifacts/{shortId}/comments` returns 200 + comments for anon on commenter+ links; still 404 for anon on viewer/none links.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/anon-comments.test.ts`:

```ts
  it("anon can read comments on a commenter link", async () => {
    const shortId = await artifactWithLink("commenter")
    await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "first!", author: "Guest" }),
    )
    const res = await anonApp.request(`/v1/artifacts/${shortId}/comments`)
    expect(res.status).toBe(200)
    const list = await res.json()
    expect(list.comments).toHaveLength(1)
    expect(list.comments[0].author).toBe("Guest")
  })

  it("anon still cannot read comments on a viewer link", async () => {
    const shortId = await artifactWithLink("viewer")
    const res = await anonApp.request(`/v1/artifacts/${shortId}/comments`)
    expect(res.status).toBe(404)
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @derive/api test -- anon-comments`
Expected: the commenter-link read test FAILS with 404 (the `anonLocked` gate).

- [ ] **Step 3: Implement**

In the comments list route, the gate currently reads:

```ts
      if (await anonLocked(c, artifact)) return bail(fail(c, 404, "not found"))
```

Change to: anonymous readers are admitted exactly when they hold comment rights (i.e. the link is commenter+); otherwise the existing account gate stands:

```ts
      // Comments are collaboration, not content: anonymous visitors on a
      // viewer/none link never see them. A commenter+ link admits guests to
      // the conversation they can write into, so the gate is "can comment",
      // not "has an account".
      if ((await anonLocked(c, artifact)) && !(await authorize(c, "comment", artifact)))
        return bail(fail(c, 404, "not found"))
```

Grep `comments.ts` for every other `anonLocked` use (single-comment GET, thread endpoints, reactions listing if present) and apply the same compound gate ONLY to pure read endpoints. Leave any mutation gate untouched.

- [ ] **Step 4: Run the API suite**

Run: `pnpm --filter @derive/api test -- anon-comments` then `pnpm --filter @derive/api test -- comment`
Expected: PASS everywhere (comment-access.test.ts is the suite most likely to assert the old 404; update any case that asserted anon-404 on a commenter link, keeping the viewer-link 404 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/comments.ts apps/api/test/anon-comments.test.ts apps/api/test/comment-access.test.ts
git commit -m "feat(api): guests on commenter links can read the comment thread

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Include `comment-access.test.ts` only if it needed updating.)

---

### Task 4: API — stricter per-IP rate limit for anonymous comment creation

**Files:**
- Modify: `apps/api/src/lib/rate-limit.ts` (Limiters interface + builder)
- Modify: `apps/api/src/context.ts` (expose the limiter)
- Modify: `apps/api/src/routes/comments.ts` (pick the anon limiter for anon callers)
- Test: `apps/api/test/anon-comments.test.ts` (extend)

**Interfaces:**
- Consumes: existing `limited(c, limiter)` helper (keys anon callers by `ip:<clientIp>` via `actorKey` — already correct for this).
- Produces: `limiters.anonComment` — `inMemoryLimiter(60_000, 5)` (5 creates/min/IP); context exposes `anonCommentLimiter`; the create route uses it for anon callers and keeps `commentLimiter` for signed-in.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/anon-comments.test.ts`. First check how existing rate-limit tests construct an app with limits enabled — grep `apps/api/test` for `rateLimit` (e.g. a `quotaApp` or deps override in helpers). Follow that pattern; the shared `anonApp` may have limits off. If the harness builds apps via `createApp(deps)`, construct one with `rateLimit: true` and its own store, then:

```ts
  it("anon comment creation is capped at 5/min per IP", async () => {
    // rlApp: an app instance with rateLimit enabled, built per the existing
    // rate-limit test pattern in this suite (see helpers/quotaApp usage).
    const shortId = await artifactWithLinkOn(rlApp, "commenter")
    let last = 0
    for (let i = 0; i < 6; i++) {
      const res = await rlAnon.request(
        `/v1/artifacts/${shortId}/comments`,
        json({ body_md: `spam ${i}`, author: "Flood" }),
      )
      last = res.status
    }
    expect(last).toBe(429)
  })
```

Adapt `artifactWithLinkOn`/`rlAnon` to the actual harness shapes you find; the assertion (6th anon create in a minute → 429) is the requirement. If enabling rate limits requires a differently-authed app for the setup steps, mirror how `quotaApp` tests do setup.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @derive/api test -- anon-comments`
Expected: FAIL — 6th request returns 201 (only the generous 60/min shared limiter applies).

- [ ] **Step 3: Implement**

`apps/api/src/lib/rate-limit.ts` — add to the `Limiters` interface, next to `comment`:

```ts
  /** Anonymous guest comment creation, keyed by IP: far tighter than the
   *  signed-in rate — a guest thread is a conversation, not a firehose. */
  anonComment: Limiter
```

and in the builder next to `comment: inMemoryLimiter(...)`:

```ts
    anonComment: inMemoryLimiter(60_000, opts.anonCommentRate ?? 5),
```

(add `anonCommentRate?: number` to the opts type alongside `commentRate`).

`apps/api/src/context.ts` — next to `const commentLimiter = ...`:

```ts
  const anonCommentLimiter = deps.rateLimit ? limiters.anonComment : null
```

and add `anonCommentLimiter,` to the returned context object (next to `commentLimiter,`).

`apps/api/src/routes/comments.ts` — destructure `anonCommentLimiter` alongside `commentLimiter` from the ctx, and in the create handler replace:

```ts
      const rl = await limited(c, commentLimiter)
```

with:

```ts
      // Guests get a much tighter cap than the signed-in comment rate; keyed
      // by IP via actorKey. The acting lookup is memoized, so this is cheap.
      const rl = await limited(c, (await actingUser(c)) ? commentLimiter : anonCommentLimiter)
```

(If `actingUser` is not already in scope at that point, hoist the existing `const acting = await actingUser(c)` above the limiter call and reuse it for both the limiter choice and the author block — do not call it twice for style points; once hoisted, use `acting ? commentLimiter : anonCommentLimiter`.)

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @derive/api test -- anon-comments` and `pnpm --filter @derive/api test`
Expected: PASS; no unrelated failures.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/rate-limit.ts apps/api/src/context.ts apps/api/src/routes/comments.ts apps/api/test/anon-comments.test.ts
git commit -m "feat(api): tight per-IP rate limit on guest comment creation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: API wire + types — expose `guest` on the Comment schema, regen types

**Files:**
- Modify: `apps/api/src/lib/comments.ts` (`commentJson`)
- Modify: `apps/api/src/routes/comments.ts` (Comment zod schema)
- Regen: `apps/api/openapi.json` (via `pnpm --filter @derive/api gen:openapi`)
- Regen: `apps/web/src/api-types.ts` (via `pnpm --filter @derive/web gen:api-types`)
- Test: `apps/api/test/anon-comments.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's `meta.guest === true` stamp.
- Produces: wire field `guest?: boolean` on every comment payload (true only for guest-authored rows); regenerated `components["schemas"]["Comment"]` so the web `Comment` type carries `guest?: boolean`. Task 7 renders the badge from it.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/anon-comments.test.ts`:

```ts
  it("guest comments carry guest:true on the wire; signed rows do not", async () => {
    const shortId = await artifactWithLink("commenter")
    const guest = await (
      await anonApp.request(
        `/v1/artifacts/${shortId}/comments`,
        json({ body_md: "guest here", author: "Guest" }),
      )
    ).json()
    expect(guest.guest).toBe(true)
    const owner = await (
      await app.request(`/v1/artifacts/${shortId}/comments`, json({ body_md: "owner here" }))
    ).json()
    expect(owner.guest).toBeUndefined()
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @derive/api test -- anon-comments`
Expected: FAIL — `guest` is undefined on the guest row (meta is stored but not unpacked to the wire).

- [ ] **Step 3: Implement**

`apps/api/src/lib/comments.ts`, in `commentJson`, add to the returned object (next to `deleted`):

```ts
    ...(md.guest ? { guest: true } : {}),
```

`apps/api/src/routes/comments.ts`, in the Comment zod schema (next to `deleted`):

```ts
      guest: z
        .boolean()
        .optional()
        .describe("True when the author was an anonymous guest (self-named, no account)."),
```

- [ ] **Step 4: Run tests, then regenerate the spec and web types**

Run: `pnpm --filter @derive/api test -- anon-comments` → PASS
Run: `pnpm --filter @derive/api gen:openapi` (updates `apps/api/openapi.json`)
Run: `pnpm --filter @derive/web gen:api-types` (updates `apps/web/src/api-types.ts`)
Run: `pnpm lint:api-types` → ok

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/comments.ts apps/api/src/routes/comments.ts apps/api/openapi.json apps/web/src/api-types.ts apps/api/test/anon-comments.test.ts
git commit -m "feat(api): expose guest flag on the comment wire shape

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Web — guest name field, guest-aware create, retire "Sign in to comment"

**Files:**
- Create: `apps/web/src/lib/guest-name.ts` + `apps/web/src/lib/guest-name.test.ts`
- Modify: `apps/web/src/api.ts` (comment body type gains `author?: string`)
- Modify: `apps/web/src/pages/artifact/artifact-actions.ts` (send author when anon; optimistic author; expose `isGuest`, `guestName`, `setGuestName` on the actions context)
- Modify: `apps/web/src/pages/artifact/comment-composer.tsx` (name field in `Composer`)
- Modify: `apps/web/src/pages/artifact/comment-thread.tsx` (name field on the reply line)
- Modify: `apps/web/src/pages/artifact/lib/comment-access.ts` + its test (retire `shouldPromptSignInToComment`)
- Modify: `apps/web/src/pages/artifact/index.tsx` (remove the sign-in-to-comment floating button + its import)

**Interfaces:**
- Consumes: `my_role === "commenter"` now arrives for anon on commenter+ links (Task 1), so `canCommentWithRole` already shows the composer; `api.comment` passes `author` through (server requires it for anon, Task 2).
- Produces: `getGuestName(): string` / `setGuestName(name: string): void` (localStorage key `"derive:guest-name"`, trimmed, 80-char cap) in `apps/web/src/lib/guest-name.ts`; actions context gains `isGuest: boolean`, `guestName: string`, `setGuestName(v: string): void`.

- [ ] **Step 1: Write the failing unit test for the storage helper**

`apps/web/src/lib/guest-name.test.ts` (mirror the style of `guest-id.test.ts` in the same directory — jsdom localStorage):

```ts
import { beforeEach, describe, expect, it } from "vitest"
import { getGuestName, setGuestName } from "./guest-name"

describe("guest name storage", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips a trimmed name", () => {
    setGuestName("  Glen  ")
    expect(getGuestName()).toBe("Glen")
  })

  it("returns empty when unset", () => {
    expect(getGuestName()).toBe("")
  })

  it("caps at 80 characters", () => {
    setGuestName("x".repeat(120))
    expect(getGuestName()).toHaveLength(80)
  })

  it("survives storage being unavailable", () => {
    // guest-id.test.ts has the established pattern for simulating a throwing
    // localStorage in this suite; reuse it. Both fns must no-op, not throw.
  })
})
```

Fill the last test body using the exact pattern found in `guest-id.test.ts` (do not invent a new mocking approach; if that file has no such case, drop this test and match whatever defensive pattern `guest-id.ts` itself uses).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @derive/web test -- guest-name`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the helper**

`apps/web/src/lib/guest-name.ts` (mirror `guest-id.ts`'s defensive try/catch style):

```ts
const KEY = "derive:guest-name"
const MAX = 80

/** The guest's self-provided display name, persisted per browser so external
 *  reviewers name themselves once. Display-only — never an identity. */
export const getGuestName = (): string => {
  try {
    return (localStorage.getItem(KEY) ?? "").trim().slice(0, MAX)
  } catch {
    return ""
  }
}

export const setGuestName = (name: string): void => {
  try {
    localStorage.setItem(KEY, name.trim().slice(0, MAX))
  } catch {
    // Storage unavailable (private mode): the field still works per-pageload.
  }
}
```

Run: `pnpm --filter @derive/web test -- guest-name` → PASS.

- [ ] **Step 4: Thread the guest name through create**

`apps/web/src/api.ts` — the `comment` method's body type gains `author?: string`:

```ts
  comment: (
    id: string,
    body: {
      body_md: string
      thread_id?: string
      anchor?: unknown
      mentions?: Mention[]
      author?: string
    },
  ): Promise<Comment> => f(`/v1/artifacts/${id}/comments`, opts(body)).then(j),
```

`apps/web/src/pages/artifact/artifact-actions.ts`:
1. Import the lib with an alias to avoid a name collision with the exposed setter: `import { getGuestName, setGuestName as persistGuestName } from "@/lib/guest-name"`. Add local state so edits re-render: `const [guestName, setGuestNameState] = useState(getGuestName)` and expose `const setGuestName = (v: string) => { persistGuestName(v); setGuestNameState(v.trim().slice(0, 80)) }` (persist first, then mirror to state; read the file's structure and place state where `me` lives).
2. In `addComment`, when there is no `me`, include the author and use it optimistically:

```ts
    const guestAuthor = !me ? guestName : undefined
    const optimistic: Comment = {
      // ...existing fields...
      author: me?.name ?? me?.email ?? (guestAuthor || "You"),
      ...(guestAuthor ? { guest: true } : {}),
    }
```

and pass `author: guestAuthor` through the mutation into `api.comment` (follow the existing `{ text, opts, optimistic }` shape — add `author` to the mutation variables and spread it into the request body).
3. Expose on the returned actions value (next to `meName`): `isGuest: !me`, `guestName`, `setGuestName`.

- [ ] **Step 5: The name field UI**

`apps/web/src/pages/artifact/comment-composer.tsx` — inside `Composer`, above the `MentionField`, render for guests (get `isGuest`, `guestName`, `setGuestName` from `useActions()` — check the import used by `comment-thread.tsx` line ~364 for the exact hook name/path):

```tsx
      {isGuest && (
        <div className="px-2.5 pt-2.5">
          <input
            data-testid="guest-name-input"
            className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none focus:border-ring"
            placeholder="Your name (required)"
            value={guestName}
            maxLength={80}
            onChange={(e) => setGuestName(e.target.value)}
          />
        </div>
      )}
```

Gate submit: in `Composer`'s `submit`, require the name for guests: `if (text.trim() && (!isGuest || guestName.trim())) onSubmit(text, resolved)`. Use the design-token classes above only if they exist in this codebase's patterns — copy the exact input styling from an existing small input in `pages/` (e.g. the share dialog) rather than inventing classes, and keep `data-testid` (lint:testids requires it). NOTE: `pnpm lint:tokens` forbids hardcoded colors/text sizes — reuse existing utility classes verbatim from a neighboring input.

`apps/web/src/pages/artifact/comment-thread.tsx` — the reply line (the `canComment &&` block around line 665): add the same guarded input above the reply `MentionField` when `isGuest` (pull `isGuest`, `guestName`, `setGuestName` from the same `useActions()` already destructured at line ~364), with `data-testid="guest-name-reply-input"`, and gate `sendReply` the same way.

- [ ] **Step 6: Retire the sign-in prompt**

- `apps/web/src/pages/artifact/lib/comment-access.ts`: delete `shouldPromptSignInToComment`.
- `apps/web/src/pages/artifact/lib/comment-access.test.ts`: delete its cases; keep/extend `canCommentWithRole` cases.
- `apps/web/src/pages/artifact/index.tsx`: remove the `promptSignInToComment` computation, the floating "Sign in to comment" button JSX it renders, and the now-unused import. `pnpm lint:deadcode` (knip) will catch leftovers.

- [ ] **Step 7: Verify**

Run: `pnpm --filter @derive/web test` → PASS
Run: `pnpm --filter @derive/web typecheck` → clean
Run: `pnpm lint:testids && pnpm lint:tokens && pnpm lint:frontend` → ok

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/guest-name.ts apps/web/src/lib/guest-name.test.ts apps/web/src/api.ts apps/web/src/pages/artifact/artifact-actions.ts apps/web/src/pages/artifact/comment-composer.tsx apps/web/src/pages/artifact/comment-thread.tsx apps/web/src/pages/artifact/lib/comment-access.ts apps/web/src/pages/artifact/lib/comment-access.test.ts apps/web/src/pages/artifact/index.tsx
git commit -m "feat(web): guest commenting — required name field, no more sign-in wall

Anonymous visitors on commenter links now get the composer (their
my_role arrives as commenter) with a required, localStorage-persisted
name field on both the composer and the reply line. The floating
'Sign in to comment' prompt is retired — the composer replaces it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Web — guest badge on comment rows

**Files:**
- Modify: `apps/web/src/pages/artifact/comment-thread.tsx` (`CommentRow` author line)

**Interfaces:**
- Consumes: `Comment.guest?: boolean` from Task 5's regenerated types.
- Produces: a small "guest" chip after the author name on any comment with `guest === true`.

- [ ] **Step 1: Locate the author render**

In `comment-thread.tsx`, find `CommentRow` and the element rendering `c.author`. Read the surrounding JSX for the exact classes used by small metadata chips in this file (the quote chip / state chips are nearby patterns).

- [ ] **Step 2: Implement**

Next to the author name, add (copying chip classes from an existing neighboring chip rather than these placeholders, and honoring lint:tokens):

```tsx
              {c.guest && (
                <span
                  data-testid="guest-badge"
                  className="rounded border border-border px-1 text-2xs text-muted-foreground"
                  title="Self-provided name, no account"
                >
                  guest
                </span>
              )}
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter @derive/web typecheck && pnpm --filter @derive/web test` → clean/PASS
Run: `pnpm lint:testids && pnpm lint:tokens` → ok

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/artifact/comment-thread.tsx
git commit -m "feat(web): guest badge on anonymous comments

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification + PR

**Files:** none new.

- [ ] **Step 1: Full suite**

Run from repo root:
```bash
pnpm -r test && pnpm -r typecheck && pnpm precommit
```
Expected: all green (precommit runs biome + every lint:* gate). Fix anything that fails before proceeding; do not skip gates.

- [ ] **Step 2: End-to-end sanity (manual, dev server)**

Run: `pnpm dev` + `pnpm dev:web`, then in a browser: publish an artifact, set link to "Can comment", open the link in a private window (logged out) and verify: composer visible with name field; posting without a name is blocked; posting with a name lands with a guest badge; the thread is readable; a viewer-link artifact still hides comments when logged out. This is the spec's acceptance walk — do it, don't assume it.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/anon-commenting
```

`gh` is NOT installed on this machine — do not try it. Emit the PR-create URL (`https://github.com/derive-to/derive/pull/new/feat/anon-commenting`) plus a ready-to-paste title and body. Title: `Guest comments: anyone with a commenter link can comment, named`. Body: summarize the permission relaxation (anon capped at commenter, only via commenter+ links), the required name + guest stamp + badge, the per-IP rate limit, reads opened on commenter links, the retired sign-in wall, and the test coverage; note the deliberate invariant change in `permissions.ts` for the reviewer, and end with the standard Claude Code attribution line.
