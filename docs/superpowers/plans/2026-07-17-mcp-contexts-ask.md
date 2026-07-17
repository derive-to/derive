# MCP Contexts Ask Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new MCP tools, `list_contexts` and `ask`, so a connected agent can ask a workspace's Contexts (askable data agents) on its human's behalf, per the approved spec `docs/plans/mcp-contexts-ask.md`.

**Architecture:** The tools live in `buildServer` in `apps/api/src/mcp.ts` and call the `ctx.meta` store ports directly, like every other MCP tool. Authorization is the acting human's own ask-grant, via a new user-id-keyed `canUserAskContext` extracted from `canAskContext` in `apps/api/src/context.ts`. A new `session.settled` domain event, published by the REST settle writes in `apps/api/src/routes/contexts.ts`, wakes `ask`'s long-poll (the `check_requests` wait pattern). A new `ask` rate limiter caps MCP session writes per acting human.

**Tech Stack:** TypeScript, Hono, `@modelcontextprotocol/sdk` (McpServer), Zod, Vitest. No schema/DB changes, no OpenAPI changes, no web changes.

## Global Constraints

- Work in the worktree `/Users/connor/Downloads/Claude/Derive/derive/.claude/worktrees/brandprint-rework`, branch `feat/mcp-contexts-ask`. Never `cd` to the main checkout.
- Use `corepack pnpm` for every package command.
- Every commit runs the repo's precommit lint suite automatically (biome + a dozen check scripts, ~1 min). The 3 biome warnings about `library/index.tsx`, `folders.ts`, and `comment-panels.tsx` are pre-existing on main; they are warnings, not blockers. Do not fix them in this branch.
- Code comments follow the repo's house voice (em dashes, lowercase after colons, explain the WHY/invariant, never narrate the next line).
- MCP tool results use the file-local helpers: `json(...)` for success payloads, `err("...")` for actionable errors. REST error contract stays `fail()` (lint:api enforces it).
- The spec is `docs/plans/mcp-contexts-ask.md`. Key invariants: askers are people (a session is on behalf of a human); a context's existence never leaks (missing and forbidden read the same); management stays off the MCP.
- End every commit message with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01NqPGBUkUwPneYSkSyqrRhH
```

---

### Task 1: the `session.settled` wake event

The REST settle writes publish a wake event on the asker's user channel so an MCP `ask({wait})` long-poll can wake the instant the runner answers (or the session is failed/closed) instead of sleeping out its timeout. The event is a wake signal only; waiters always re-read the store.

**Files:**
- Modify: `apps/api/src/events.ts` (DOMAIN_EVENTS list, after `"request.created"`)
- Modify: `apps/api/src/routes/contexts.ts` (destructure `bus`; three publish sites)
- Test: `apps/api/test/contexts.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `ctx.bus.publish(channel: string, e: DeriveEvent): void` (the `Backplane` on `AppContext`), `DeriveEvent` requires `type` to be in the `DomainEvent` union.
- Produces: domain event `"session.settled"` with payload `{ session_id: string, state: SessionState }` on channel `` `u:${asker_id}` ``. Task 5's wait loop listens for exactly this type on exactly this channel.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/contexts.test.ts` (add `createInProcessBackplane` and `DeriveEvent` to the imports from `../src/bus` at the top of the file; `vitest`/helpers imports already exist):

```ts
// The terminal-turn wake: every settle write (the runner's answer, a crash-fail,
// an asker/owner close) publishes `session.settled` on the ASKER's `u:<id>`
// channel, so an MCP ask({wait}) long-poll wakes at once. A wake signal only —
// waiters re-read the session — so an asker follow-up (state back to `open`)
// must NOT publish it.
describe("session.settled — the terminal-turn wake event", () => {
  const owner: TestUser = { id: "u_sw_own", email: "swown@derive.test", name: "Owner" }

  const setup = async (name: string) => {
    const backplane = createInProcessBackplane()
    const { app } = makeAuthedApp(name, [owner], "commenter", { deps: { backplane } })
    await app.request("/v1/me", { headers: as(owner.email) })
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst" }))
    ).json()
    const manifest = await (await publishAs(app, "# manifest", {}, as(owner.email))).json()
    const cx = await (
      await app.request(
        "/v1/contexts",
        jsonAs(as(owner.email), {
          name: "Analytics",
          agent_id: ag.id,
          manifest_short_id: manifest.short_id,
        }),
      )
    ).json()
    const opened = await (
      await app.request(
        `/v1/contexts/${cx.id}/sessions`,
        jsonAs(as(owner.email), { body_md: "what changed?" }),
      )
    ).json()
    const events: DeriveEvent[] = []
    backplane.subscribe(`u:${owner.id}`, (e) => events.push(e))
    const settled = () => events.filter((e) => e.type === "session.settled")
    return { app, agentToken: ag.token as string, session: opened.session, settled }
  }

  it("the runner's answer publishes it on the asker's channel", async () => {
    const { app, agentToken, session, settled } = await setup("session-wake-answer")
    const res = await app.request(`/v1/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ body_md: "All quiet.", state: "answered" }),
    })
    expect(res.status).toBe(201)
    expect(settled()).toMatchObject([{ session_id: session.id, state: "answered" }])
  })

  it("an asker follow-up does not publish; a close does", async () => {
    const { app, session, settled } = await setup("session-wake-close")
    const follow = await app.request(
      `/v1/sessions/${session.id}/messages`,
      jsonAs(as(owner.email), { body_md: "also, why?" }),
    )
    expect(follow.status).toBe(201)
    const close = await app.request(`/v1/sessions/${session.id}`, {
      ...jsonAs(as(owner.email), { state: "closed" }),
      method: "PATCH",
    })
    expect(close.status).toBe(200)
    expect(settled()).toMatchObject([{ session_id: session.id, state: "closed" }])
  })

  it("the runner's crash-fail publishes it", async () => {
    const { app, agentToken, session, settled } = await setup("session-wake-fail")
    const res = await app.request(`/v1/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ state: "failed" }),
    })
    expect(res.status).toBe(200)
    expect(settled()).toMatchObject([{ session_id: session.id, state: "failed" }])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm -C apps/api exec vitest run test/contexts.test.ts -t "session.settled"`
Expected: 3 FAIL (settled() is empty — no publishes exist yet). If the failure is instead a TS error that `"session.settled"` is not a `DomainEvent`, that is the same missing piece; continue.

- [ ] **Step 3: Add the domain event**

In `apps/api/src/events.ts`, inside `DOMAIN_EVENTS`, directly after the `"request.created"` entry:

```ts
  // A session reached a terminal turn — the runner answered (answered/escalated),
  // the run crashed (failed), or the asker/owner ended it (closed). Emitted on
  // the ASKER's `u:<id>` channel so an MCP ask({wait}) long-poll wakes at once.
  // A wake signal only (waiters re-read the session); not webhook-eligible.
  "session.settled",
```

- [ ] **Step 4: Publish from the three settle writes**

In `apps/api/src/routes/contexts.ts`:

(a) Add `bus` to the destructuring at the top of `contextRoutes` (the `const { meta, activeWorkspace, ... } = ctx` block): insert `bus,` after `authorize,` keeping alphabetical-ish order.

(b) In `POST /v1/sessions/{id}/messages`, agent branch — after `const m = await meta.addSessionMessage({...}, state)` and before its `return c.json({ message: messageJson(m) }, 201)`:

```ts
        // Wake any ask({wait}) long-poll the instant the turn settles. The stale-
        // answer race above keeps state `open` — correctly no wake: the runner
        // still owes a reply.
        if (state !== "open")
          bus.publish(`u:${s.asker_id}`, { type: "session.settled", session_id: s.id, state })
```

(c) In `PATCH /v1/sessions/{id}`, agent branch — after the `const updated = await meta.setSessionState(s.id, b.state)` null-check succeeds, before `return c.json({ session: sessionJson(updated) })`:

```ts
        bus.publish(`u:${s.asker_id}`, {
          type: "session.settled",
          session_id: s.id,
          state: b.state,
        })
```

(d) Same insertion in the user (close) branch of the same PATCH route, after its own `setSessionState` null-check, before its `return c.json({ session: sessionJson(updated) })`. The code is identical to (c) — `b.state` is `"closed"` there.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `corepack pnpm -C apps/api exec vitest run test/contexts.test.ts`
Expected: ALL pass (the new 3 and every pre-existing contexts test).

- [ ] **Step 6: Typecheck and commit**

Run: `corepack pnpm -C apps/api typecheck`
Expected: clean (both configs).

```bash
git add apps/api/src/events.ts apps/api/src/routes/contexts.ts apps/api/test/contexts.test.ts
git commit -m "feat(contexts): session.settled — settle writes wake the asker's channel"
```

---

### Task 2: extract `canUserAskContext` (pure refactor)

The ask-grant rule keyed to a user id, so the MCP tools (which act for `actingFor`, not a signed-in user) share the exact rule the REST routes enforce.

**Files:**
- Modify: `apps/api/src/context.ts` (the `canAskContext` block, ~line 907; the return object, ~line 973)

**Interfaces:**
- Produces: `canUserAskContext(userId: string, x: ContextRecord): Promise<boolean>` exported on `AppContext` (the inferred return type — adding it to the return object is the whole export). Tasks 4 and 5 call `ctx.canUserAskContext(actingFor.id, x)`.
- `canAskContext(c, x)` behavior is unchanged.

- [ ] **Step 1: Replace the `canAskContext` implementation**

In `apps/api/src/context.ts`, replace this block:

```ts
  const canAskContext = async (c: Context, x: ContextRecord): Promise<boolean> => {
    const me = await currentUser(c)
    if (!me) return false
    if (!(await meta.getMembership(x.org_id, me.id))) return false
    if (x.created_by === me.id) return true
    if (x.ask_policy === "workspace") return true
    return !!(await meta.getContextAsker(x.id, me.id))
  }
```

with:

```ts
  // The id-keyed core of the rule, shared with the MCP ask tools — which act for
  // the connection's on-behalf human rather than a signed-in user, but must hold
  // exactly the same grant. Membership is the hard floor; `workspace` policy
  // admits every member; `invited` admits the creator and the roster.
  const canUserAskContext = async (userId: string, x: ContextRecord): Promise<boolean> => {
    if (!(await meta.getMembership(x.org_id, userId))) return false
    if (x.created_by === userId) return true
    if (x.ask_policy === "workspace") return true
    return !!(await meta.getContextAsker(x.id, userId))
  }
  const canAskContext = async (c: Context, x: ContextRecord): Promise<boolean> => {
    const me = await currentUser(c)
    return !!me && (await canUserAskContext(me.id, x))
  }
```

(The multi-line comment currently above `canAskContext` stays where it is — it documents the rule both functions now share.)

- [ ] **Step 2: Export it**

In the return object at the bottom of `createAppContext`, add `canUserAskContext,` on the line after `canAskContext,`.

- [ ] **Step 3: Verify no behavior change**

Run: `corepack pnpm -C apps/api exec vitest run test/contexts.test.ts test/authz-coverage.test.ts`
Expected: ALL pass.

Run: `corepack pnpm -C apps/api typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/context.ts
git commit -m "refactor(contexts): canUserAskContext — the ask grant keyed by user id"
```

---

### Task 3: the `ask` rate limiter

Every MCP ask/follow-up triggers a model run on a context owner's runner, so a looping agent is the realistic flood. A dedicated limiter (not the comment one — separate budgets) keyed by the acting human.

**Files:**
- Modify: `apps/api/src/lib/rate-limit.ts` (the `RateLimiters` interface + `inMemoryRateLimiters`)
- Modify: `apps/api/src/worker.ts` (the `rateLimiters:` map, ~line 267)
- Modify: `apps/api/src/context.ts` (build + export `askLimiter`, next to the others at ~line 260 and in the return object)

**Interfaces:**
- Produces: `ctx.askLimiter: Limiter | null` on `AppContext` (null when `deps.rateLimit` is off — the same nullability contract as `publishLimiter`). `Limiter = (key: string) => Promise<{ ok: boolean; retryAfter: number }>`. Task 5 calls it with key `` `id:${actingFor.id}` ``.
- `inMemoryRateLimiters` gains an `askRate?: number` opt (default 10/min) — Task 6's rate-limit test constructs `inMemoryRateLimiters({ askRate: 2 })`.

- [ ] **Step 1: Extend the limiter set**

In `apps/api/src/lib/rate-limit.ts`, add to the `RateLimiters` interface (after `invite: Limiter`):

```ts
  /** MCP `ask` — each ask triggers a model run on a context owner's runner, so a
   *  looping agent is the realistic flood. Keyed by the acting human's id. */
  ask: Limiter
```

Change the `inMemoryRateLimiters` opts type to `{ publishRate?: number; commentRate?: number; askRate?: number }` and add to its returned object (after `invite:`):

```ts
    // 10 asks per minute per acting human: a human-paced agent never sees it; a
    // runaway ask loop does — each ask is a model run on someone's runner.
    ask: inMemoryLimiter(60_000, opts.askRate ?? 10),
```

- [ ] **Step 2: Wire the edge binding**

In `apps/api/src/worker.ts`, in the `rateLimiters: { ... }` map, after the `comment:` line:

```ts
          // Rides the comment binding, namespaced — same order of magnitude of
          // legitimate use, but its count must not share the comment budget.
          ask: nativeLimiter(env.RL_COMMENT, 60, "ask"),
```

- [ ] **Step 3: Expose it on AppContext**

In `apps/api/src/context.ts`, after `const inviteLimiter = deps.rateLimit ? limiters.invite : null`:

```ts
  const askLimiter = deps.rateLimit ? limiters.ask : null
```

and add `askLimiter,` to the return object on the line after `inviteLimiter,` (find `inviteLimiter,` in the return list; if the list has `commentLimiter,`/`unlockLimiter,`/`inviteLimiter,` grouped, keep the group together).

- [ ] **Step 4: Typecheck (both configs — worker.ts only compiles under the worker config) and commit**

Run: `corepack pnpm -C apps/api typecheck`
Expected: clean.

Run: `corepack pnpm -C apps/api exec vitest run test/contexts.test.ts`
Expected: pass (no behavior change yet; the limiter is exercised in Task 6).

```bash
git add apps/api/src/lib/rate-limit.ts apps/api/src/worker.ts apps/api/src/context.ts
git commit -m "feat(rate-limit): a dedicated ask limiter for the MCP contexts surface"
```

---

### Task 4: the `list_contexts` tool

Ask-scoped discovery: the contexts the acting human may ask, runner liveness, the manifest identity, and the caller's own resumable sessions. Registered on every connection (the house rule); refused at call time without an acting human.

**Files:**
- Modify: `apps/api/src/mcp.ts` (imports; the file-header tool list comment; the instructions string; a new section before the `setup_brandprint` registration)
- Test: `apps/api/test/mcp-contexts.test.ts` (new file)

**Interfaces:**
- Consumes: `ctx.canUserAskContext(userId, x)` (Task 2), `ctx.meta.listContexts(orgId)`, `ctx.meta.getArtifactsByIds(ids)`, `ctx.meta.listSessions(contextId, { askerId, limit })`, plus the file-local `resolveWs`, `wsArg`, `json`, `err`, `actingFor`.
- Produces (for Task 5, same file scope): `const RUNNER_ONLINE_MS = 90_000`, `const NO_HUMAN = "..."`, and `askableContexts(org: string, userId: string): Promise<{ x: ContextRecord; manifest: ArtifactRecord | null }[]>`.
- Produces (for the test file, reused by Tasks 5-6): the `call`/`callRaw` helpers and the `setup()` fixture shown in Step 1.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/mcp-contexts.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createInProcessBackplane } from "../src/bus"
import { sha256 } from "../src/lib/crypto"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The MCP ask surface: list_contexts + ask act for the connection's on-behalf
// human (the token's registrant / the OAuth grantor), gated per call by that
// human's OWN ask-grant — canUserAskContext, the same rule the console enforces.
// The tools are registered on every connection (the surface never differs by
// auth kind); a connection with no known human is refused at call time.
//
// Cast: owner (Admin) registers the agents — the answering one and "OwnerBot",
// the MCP connection under test, whose acting human is therefore OWNER. dev
// (editor) publishes the manifest and creates the context, so dev is the
// CREATOR and owner is a plain member — the interesting side of every policy.

const owner: TestUser = { id: "u_mcx_own", email: "mcxown@derive.test", name: "Owner" }
const dev: TestUser = { id: "u_mcx_dev", email: "mcxdev@derive.test", name: "Dev" }

type Made = ReturnType<typeof makeAuthedApp>
type App = Made["app"]

// A direct tools/call over the stateless /mcp endpoint (mcp-inbox-wait's shape).
// callRaw keeps the text + isError for error assertions; call JSON-parses a
// success payload.
const callRaw = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  const out = ct.includes("application/json")
    ? JSON.parse(txt)
    : JSON.parse(
        (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
      )
  const r = out?.result as { content?: { text: string }[]; isError?: boolean } | undefined
  const t = r?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
  return { text: t, isError: !!r?.isError }
}
const call = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
  // biome-ignore lint/suspicious/noExplicitAny: test convenience over a JSON payload
): Promise<any> => JSON.parse((await callRaw(app, token, name, args)).text)

const setup = async (name: string, deps?: Record<string, unknown>) => {
  const made = makeAuthedApp(name, [owner, dev], "editor", deps ? { deps } : undefined)
  const { app, meta } = made
  await app.request("/v1/me", { headers: as(owner.email) })
  await app.request("/v1/me", { headers: as(dev.email) })
  // Agent registration is Admin-only, so owner mints both: the context's
  // answering agent and the MCP caller under test (acting human = owner).
  const answering = await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Analyst" }))
  ).json()
  const ownerBot = await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "OwnerBot" }))
  ).json()
  // dev (editor) authors the manifest and creates the context — dev is creator.
  const manifest = await (await publishAs(app, "# Analytics manifest", {}, as(dev.email))).json()
  const cx = await (
    await app.request(
      "/v1/contexts",
      jsonAs(as(dev.email), {
        name: "Analytics",
        agent_id: answering.id,
        manifest_short_id: manifest.short_id,
      }),
    )
  ).json()
  return {
    app,
    meta,
    cx,
    manifestShortId: manifest.short_id as string,
    answeringToken: answering.token as string,
    ownerToken: ownerBot.token as string,
  }
}

describe("list_contexts — ask-scoped discovery", () => {
  it("shows only what the acting human may ask; invited admits via the roster", async () => {
    const { app, meta, cx, manifestShortId, ownerToken } = await setup("mcx-list")
    // Default ask_policy is `invited` (creator + roster): owner is a plain
    // member, so OwnerBot sees nothing — and learns nothing exists.
    const before = await call(app, ownerToken, "list_contexts", {})
    expect(before.count).toBe(0)
    // The creator invites owner; the same call now shows the context, offline
    // (its runner has never polled), with the manifest identity attached.
    expect(
      (await app.request(`/v1/contexts/${cx.id}/askers`, jsonAs(as(dev.email), { email: owner.email }))).status,
    ).toBe(201)
    const after = await call(app, ownerToken, "list_contexts", {})
    expect(after.count).toBe(1)
    expect(after.contexts).toMatchObject([
      {
        id: cx.id,
        name: "Analytics",
        online: false,
        manifest: { short_id: manifestShortId, title: "Analytics manifest" },
      },
    ])
    expect(after.your_open_sessions).toEqual([])
    void meta
  })

  it("workspace policy admits every member; a web-opened session shows as resumable", async () => {
    const { app, cx, ownerToken } = await setup("mcx-list-ws")
    expect(
      (await app.request(`/v1/contexts/${cx.id}/access`, jsonAs(as(dev.email), { ask_policy: "workspace" }))).status,
    ).toBe(200)
    // A session the human opened in the CONSOLE is the same session the agent
    // may resume — the MCP surface is the human's own seat.
    const opened = await (
      await app.request(`/v1/contexts/${cx.id}/sessions`, jsonAs(as(owner.email), { body_md: "Q?" }))
    ).json()
    const res = await call(app, ownerToken, "list_contexts", {})
    expect(res.count).toBe(1)
    expect(res.your_open_sessions).toMatchObject([
      { id: opened.session.id, context: "Analytics", state: "open" },
    ])
  })

  it("a connection with no acting human is refused at call time, not hidden", async () => {
    const { app, meta } = await setup("mcx-list-nohuman")
    // A pre-column legacy token: a registered agent with no created_by. Only
    // reachable by seeding the store directly — the API always stamps a creator.
    const raw = "dk_agt_mcx_legacy"
    const orgs = await meta.listWorkspaces(owner.id)
    await meta.createAgent({
      id: "ag_mcx_legacy",
      org_id: orgs[0]!.id,
      name: "Legacy",
      token: sha256(raw),
      role: "editor",
      created_by: null,
    })
    const r = await callRaw(app, raw, "list_contexts", {})
    expect(r.isError).toBe(true)
    expect(r.text).toContain("no acting human")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm -C apps/api exec vitest run test/mcp-contexts.test.ts`
Expected: 3 FAIL — the MCP error envelope says tool `list_contexts` is not found (surfaced by `callRaw`'s `no tool text` throw or an isError envelope; either failure mode is the point: the tool doesn't exist yet).

Note: if `meta.listWorkspaces` or `meta.createAgent` don't exist on the store handle with these exact names, check `packages/core/src/ports.ts` for the actual member (`listWorkspaces(userId)` and `createAgent(a: NewAgent)` per the current tree) and adjust the test, not the store.

- [ ] **Step 3: Implement the tool**

In `apps/api/src/mcp.ts`:

(a) Add `type ContextRecord,` to the existing `@derive/core` type imports (alphabetical position among the type imports; `ArtifactRecord` is already there).

(b) In the file-header comment (the "…one per intent…" inventory around lines 16-24), extend the inventory sentence: after the `setup_brandprint` parenthetical `…that doesn't reduce to a parameter on another tool)`, insert:

```
, and ASK a workspace context (list_contexts + ask: query the live data agents
// a workspace hosts, acting for the connection's human — discovery and the
// session loop, the one surface where Derive routes a question to a runner)
```

(adjust the `//` continuation to match the surrounding comment block's wrapping).

(c) In the `instructions` template string, after the sentence ending `so you never need to switch just to open a doc.` and before `brandprintInstructions(...)`, insert:

```ts
        ` Workspaces can also host contexts — askable live data agents. list_contexts shows the ` +
        `ones your user may ask (and whether each runner is online); ask opens a question session ` +
        `on your user's behalf and returns the answer, or a session id to resume when the runner ` +
        `needs longer.` +
```

(d) Directly before the `setup_brandprint` registration (`// The MCP-side Brandprint bootstrap…` comment block), add the section. This task adds the shared plumbing plus `list_contexts`; Task 5 appends `ask` in the same section:

```ts
  // ASK A CONTEXT — query a workspace's live data agents ------------------------
  // Contexts are askable agent setups (a registered agent wired to a manifest,
  // answering through an owner-run runner). These two tools are the agent-side
  // ask surface, acting FOR the connection's on-behalf human: the human's own
  // ask-grant (membership + ask_policy/roster, re-checked per call via
  // canUserAskContext) is the ONLY gate, so an agent can ask exactly what its
  // human can ask, and nothing more. Registered on every connection like
  // check_requests (the tool surface never differs by auth kind); a connection
  // with no known human is refused at call time instead. Management (create/
  // rewire/delete) deliberately has no MCP path.

  // The console's liveness window: a runner is "online" while its last queue
  // poll (stamped at most once a minute) is within this.
  const RUNNER_ONLINE_MS = 90_000
  const NO_HUMAN =
    "This connection has no acting human, and askers are people — a session is opened on your " +
    "user's behalf. Reconnect with an OAuth login (or a token registered by a user) to ask."

  // The contexts `userId` may ask in `org`, each with its manifest (identity +
  // the current version a new session pins). One listContexts + one batched
  // artifact read; the per-context grant checks are membership/roster lookups.
  const askableContexts = async (org: string, userId: string) => {
    const rows = await ctx.meta.listContexts(org)
    const mine: ContextRecord[] = []
    for (const x of rows) if (await ctx.canUserAskContext(userId, x)) mine.push(x)
    const manifests = await ctx.meta.getArtifactsByIds(mine.map((x) => x.manifest_artifact_id))
    const byId = new Map(manifests.map((a) => [a.id, a]))
    return mine.map((x) => ({ x, manifest: byId.get(x.manifest_artifact_id) ?? null }))
  }
  const runnerOnline = (x: ContextRecord) =>
    !!x.runner_seen_at && Date.now() - new Date(x.runner_seen_at).getTime() < RUNNER_ONLINE_MS

  server.registerTool(
    "list_contexts",
    {
      description:
        "List the CONTEXTS you may ask in a workspace — live data agents a workspace owner wired " +
        "up, each answering questions against its own data and tools. Returns id, name, whether " +
        "the runner is online, the manifest doc that defines it, and your own still-open sessions " +
        "so you can resume one with ask. Asking happens on your user's behalf and is granted per " +
        "context, so this list is exactly what your user may ask. Defaults to your current " +
        "workspace; pass `workspace` to look in another. Then call ask with a context's id or name.",
      inputSchema: { workspace: wsArg },
    },
    async ({ workspace }) => {
      if (!actingFor) return err(NO_HUMAN)
      const t = await resolveWs(workspace)
      if ("error" in t) return err(t.error)
      const rows = await askableContexts(t.org, actingFor.id)
      // The caller's resumable seats. A couple of small reads — a workspace holds
      // a handful of contexts — not worth a batch port. Newest 10 per context,
      // closed ones dropped (nothing to resume there).
      const sessions: { id: string; context: string; state: string; updated_at: string }[] = []
      for (const { x } of rows) {
        for (const s of await ctx.meta.listSessions(x.id, { askerId: actingFor.id, limit: 10 })) {
          if (s.state === "closed") continue
          sessions.push({
            id: s.id,
            context: x.name,
            state: s.state,
            updated_at: s.updated_at ?? s.created_at,
          })
        }
      }
      return json({
        workspace: t.org,
        count: rows.length,
        contexts: rows.map(({ x, manifest }) => ({
          id: x.id,
          name: x.name,
          online: runnerOnline(x),
          manifest: manifest ? { short_id: manifest.short_id, title: manifest.title } : null,
        })),
        your_open_sessions: sessions.slice(0, 10),
      })
    },
  )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm -C apps/api exec vitest run test/mcp-contexts.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Full API tests + typecheck, then commit**

Run: `corepack pnpm -C apps/api test` and `corepack pnpm -C apps/api typecheck`
Expected: all pass, both configs clean.

```bash
git add apps/api/src/mcp.ts apps/api/test/mcp-contexts.test.ts
git commit -m "feat(mcp): list_contexts — ask-scoped discovery of a workspace's contexts"
```

---

### Task 5: the `ask` tool

One tool, three modes by argument shape: open (`context` + `question`), follow up (`session_id` + `question`), check/resume (`session_id` alone). Wait-first: block up to `wait` seconds for the settle wake, answer from a fresh store read.

**Files:**
- Modify: `apps/api/src/mcp.ts` (append to the Task 4 section, directly after the `list_contexts` registration; extend the `@derive/core` type import)
- Test: `apps/api/test/mcp-contexts.test.ts` (append a describe block)

**Interfaces:**
- Consumes: Task 4's `askableContexts`, `runnerOnline`, `NO_HUMAN`; Task 2's `ctx.canUserAskContext`; Task 3's `ctx.askLimiter`; Task 1's `session.settled` on `` `u:${actingFor.id}` ``; the file-local `inGrant(org)`, `resolveWs`, `wsArg`, `newId`, `json`, `err`; store ports `getSession`, `getContext`, `createSession`, `addSessionMessage`, `listSessionMessages`.
- Produces: the `ask` tool. Response shape (Task 6's tests assert it): `{ session_id, context, state, answer?: { body_md, meta, created_at }, transcript?: [...], note?: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/mcp-contexts.test.ts`:

```ts
// A REST answer from the context's agent — the runner's settle write.
const answerAs = (app: App, token: string, sessionId: string, body: Record<string, unknown>) =>
  app.request(`/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

describe("ask — open, check, and the grant edges", () => {
  it("opens a session as the acting human; the console sees it as theirs", async () => {
    const { app, cx, ownerToken } = await setup("mcx-ask-open")
    expect(
      (await app.request(`/v1/contexts/${cx.id}/access`, jsonAs(as(dev.email), { ask_policy: "workspace" }))).status,
    ).toBe(200)
    const res = await call(app, ownerToken, "ask", {
      context: "Analytics",
      question: "What changed this week?",
      wait: 0,
    })
    expect(res.state).toBe("open")
    expect(res.context).toBe("Analytics")
    // The runner has never polled — the caller is told it looks offline.
    expect(res.note).toContain("OFFLINE")
    // The session is the HUMAN's: the console lists it exactly like a web ask.
    const sessions = await (
      await app.request(`/v1/contexts/${cx.id}/sessions`, { headers: as(owner.email) })
    ).json()
    expect(sessions.sessions).toMatchObject([
      { id: res.session_id, asker_id: owner.id, state: "open" },
    ])
  })

  it("returns the answer inline once the runner settled; check mode carries the transcript", async () => {
    const { app, cx, ownerToken, answeringToken } = await setup("mcx-ask-answered")
    expect(
      (await app.request(`/v1/contexts/${cx.id}/access`, jsonAs(as(dev.email), { ask_policy: "workspace" }))).status,
    ).toBe(200)
    const opened = await call(app, ownerToken, "ask", { context: cx.id, question: "Q?", wait: 0 })
    expect(
      (
        await answerAs(app, answeringToken, opened.session_id, {
          body_md: "42.",
          state: "answered",
          meta: { confidence: 0.9, artifacts: [{ short_id: "abc12345", title: "Q2 report" }] },
        })
      ).status,
    ).toBe(201)
    const res = await call(app, ownerToken, "ask", { session_id: opened.session_id, wait: 0 })
    expect(res.state).toBe("answered")
    expect(res.answer).toMatchObject({ body_md: "42.", meta: { confidence: 0.9 } })
    // Check-only mode re-grounds a resumed caller: asker turn + agent turn.
    expect(res.transcript).toMatchObject([
      { author: "asker", body_md: "Q?" },
      { author: "agent", body_md: "42." },
    ])
  })

  it("names the askable contexts when the ref misses — and stays silent when none are", async () => {
    const { app, cx, ownerToken } = await setup("mcx-ask-miss")
    // No grant at all: the miss must not enumerate what exists.
    const dark = await callRaw(app, ownerToken, "ask", { context: "Analytics", question: "Q?", wait: 0 })
    expect(dark.isError).toBe(true)
    expect(dark.text).not.toContain("Analytics")
    // Granted, a typo'd ref names what CAN be asked (askable by definition).
    expect(
      (await app.request(`/v1/contexts/${cx.id}/access`, jsonAs(as(dev.email), { ask_policy: "workspace" }))).status,
    ).toBe(200)
    const miss = await callRaw(app, ownerToken, "ask", { context: "Analytcs", question: "Q?", wait: 0 })
    expect(miss.isError).toBe(true)
    expect(miss.text).toContain("Analytics")
  })

  it("a stranger's session_id reads as missing, never forbidden", async () => {
    const { app, cx, ownerToken } = await setup("mcx-ask-leak")
    // dev (the creator) opens a session in the console; owner's agent probes it.
    const opened = await (
      await app.request(`/v1/contexts/${cx.id}/sessions`, jsonAs(as(dev.email), { body_md: "mine" }))
    ).json()
    const r = await callRaw(app, ownerToken, "ask", { session_id: opened.session.id })
    expect(r.isError).toBe(true)
    expect(r.text).toContain("No session")
    expect(r.text).not.toContain("forbidden")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm -C apps/api exec vitest run test/mcp-contexts.test.ts -t "ask —"`
Expected: 4 FAIL (tool `ask` not found).

- [ ] **Step 3: Implement the tool**

(a) Add `type SessionRecord,` to the `@derive/core` type imports in `apps/api/src/mcp.ts` (next to the `ContextRecord` added in Task 4).

(b) Directly after the `list_contexts` registration, still inside the ASK A CONTEXT section:

```ts
  server.registerTool(
    "ask",
    {
      description:
        "Ask a context (a live data agent from list_contexts) a question on your user's behalf, " +
        "or resume/follow up an existing session. OPEN: pass `context` (id or name) + `question`. " +
        "FOLLOW UP: pass `session_id` + `question`. CHECK/RESUME: pass `session_id` alone. The " +
        "call waits up to `wait` seconds (default 25) for the runner's answer and returns it " +
        "inline when it lands — real runs often take minutes, so a still-open response is normal, " +
        "not an error: re-call with the returned session_id (+ wait) until it settles. Answers " +
        "cite artifact short_ids you can then read.",
      inputSchema: {
        context: z
          .string()
          .optional()
          .describe(
            "The context to ask — its id or name from list_contexts. Opens a NEW session; omit when passing session_id.",
          ),
        question: z
          .string()
          .trim()
          .min(1)
          .max(20_000)
          .optional()
          .describe(
            "Your question (Markdown). With `context` it opens a session; with `session_id` it is a follow-up turn. Omit it to just check a session.",
          ),
        session_id: z
          .string()
          .optional()
          .describe(
            "An existing session of yours (from an earlier ask, or list_contexts) to follow up on or check.",
          ),
        wait: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe(
            "Seconds to wait for the runner's answer before returning (default 25; 0 = return at once). An expired wait leaves the session open — re-call with session_id.",
          ),
        workspace: wsArg,
      },
    },
    async ({ context, question, session_id, wait, workspace }) => {
      if (!actingFor) return err(NO_HUMAN)
      // Session WRITES are capped per acting human — each one triggers a model
      // run on the context owner's runner, so a looping agent is the realistic
      // flood. The check mode is a read and stays uncapped.
      const overAskCap = async () => {
        if (!ctx.askLimiter) return null
        const r = await ctx.askLimiter(`id:${actingFor.id}`)
        return r.ok ? null : err(`Rate limit exceeded — retry in ${r.retryAfter}s.`)
      }

      let s: SessionRecord | null = null
      let x: ContextRecord | null = null
      if (session_id) {
        if (context)
          return err("Pass `context` OR `session_id`, not both — a follow-up already knows its context.")
        const found = await ctx.meta.getSession(session_id)
        const linked = found ? await ctx.meta.getContext(found.context_id) : null
        // Ownership + the LIVE grant, re-checked per call (a human removed from
        // the workspace/roster loses ask-through-agent the moment they lose
        // ask-directly), and the OAuth grant's workspace clamp. Any miss reads
        // the same as a missing id — a session's existence never leaks.
        const allowed =
          !!found &&
          !!linked &&
          found.asker_id === actingFor.id &&
          inGrant(linked.org_id) &&
          (await ctx.canUserAskContext(actingFor.id, linked))
        if (!found || !linked || !allowed)
          return err(`No session "${session_id}" you can reach. list_contexts shows your open sessions.`)
        s = found
        x = linked
        if (question) {
          if (s.state === "closed")
            return err("That session is closed — open a new one by passing `context` + `question`.")
          const capped = await overAskCap()
          if (capped) return capped
          await ctx.meta.addSessionMessage(
            {
              id: newId("sm"),
              session_id: s.id,
              author_kind: "asker",
              author_id: actingFor.id,
              body_md: question,
            },
            "open",
          )
          s = (await ctx.meta.getSession(s.id)) ?? s
        }
      } else {
        if (!context)
          return err("Pass `context` (+ `question`) to ask, or `session_id` to check/resume. list_contexts shows both.")
        if (!question) return err("Opening a session needs a `question`.")
        const t = await resolveWs(workspace)
        if ("error" in t) return err(t.error)
        const rows = await askableContexts(t.org, actingFor.id)
        const ref = context.trim().toLowerCase()
        const hit =
          rows.find((r) => r.x.id === context) ?? rows.find((r) => r.x.name.toLowerCase() === ref)
        // Naming the askable set leaks nothing (each entry is askable by this
        // human, by definition) — and an empty set must stay a flat miss.
        if (!hit)
          return err(
            rows.length
              ? `No context "${context}" you can ask here. You can ask: ${rows.map((r) => r.x.name).join(", ")}.`
              : "No contexts you can ask in this workspace.",
          )
        if (!hit.manifest) return err(`Context "${hit.x.name}" has lost its manifest and can't be asked.`)
        const capped = await overAskCap()
        if (capped) return capped
        x = hit.x
        const opened = await ctx.meta.createSession({
          id: newId("ses"),
          context_id: x.id,
          org_id: x.org_id,
          asker_id: actingFor.id,
          context_version: hit.manifest.current_version,
        })
        await ctx.meta.addSessionMessage(
          {
            id: newId("sm"),
            session_id: opened.id,
            author_kind: "asker",
            author_id: actingFor.id,
            body_md: question,
          },
          "open",
        )
        s = (await ctx.meta.getSession(opened.id)) ?? opened
      }
      if (!s || !x) return err("Pass `context` (+ `question`) or `session_id`.")

      // Wait for the runner, then answer from a FRESH read — the event is only a
      // wake (check_requests' pattern), so a missed/raced wake is never a wrong
      // answer. The channel wakes for ANY of this human's sessions settling; the
      // loop re-checks ours and waits out the remainder.
      const deadline = Date.now() + Math.min(Math.max(wait ?? 25, 0), 50) * 1000
      while (s.state === "open" && ctx.bus.waitFor) {
        const left = deadline - Date.now()
        if (left <= 0) break
        const release = new AbortController()
        const woke = ctx.bus
          .waitFor(`u:${actingFor.id}`, ["session.settled"], left, release.signal)
          .catch(() => null)
        // Close the check-then-wait gap: the settle may have landed since the
        // last read, before our subscription existed.
        const fresh = await ctx.meta.getSession(s.id)
        if (fresh && fresh.state !== "open") {
          release.abort()
          await woke
          s = fresh
          break
        }
        const e = await woke
        s = (await ctx.meta.getSession(s.id)) ?? s
        if (!e) break // timed out
      }

      const transcript = await ctx.meta.listSessionMessages(s.id)
      const answerRow =
        s.state !== "open" ? transcript.filter((m) => m.author_kind === "agent").at(-1) : undefined
      // Stored as TEXT (see ports); a hand-edited row must not 500 the tool —
      // unparseable meta reads as absent, the same tolerance the route shows.
      let answerMeta: unknown = null
      if (answerRow?.meta) {
        try {
          answerMeta = JSON.parse(answerRow.meta)
        } catch {
          answerMeta = null
        }
      }
      const checkOnly = !!session_id && !question
      const note =
        s.state === "open"
          ? runnerOnline(x)
            ? "Still thinking — real runs take minutes. Re-call ask with this session_id (+ wait) to collect the answer."
            : "Queued, but the context's runner looks OFFLINE — it answers when it comes back. Re-call ask with this session_id later."
          : s.state === "escalated"
            ? "The runner escalated this to a human — a draft went to review. Check back later."
            : s.state === "failed"
              ? "The run crashed; the context's owner sees the failure. You can ask again."
              : s.state === "closed"
                ? "This session was closed."
                : undefined
      return json({
        session_id: s.id,
        context: x.name,
        state: s.state,
        ...(answerRow
          ? {
              answer: {
                body_md: answerRow.body_md,
                meta: answerMeta,
                created_at: answerRow.created_at,
              },
            }
          : {}),
        ...(checkOnly
          ? {
              transcript: transcript
                .slice(-20)
                .map((m) => ({ author: m.author_kind, body_md: m.body_md, created_at: m.created_at })),
            }
          : {}),
        ...(note ? { note } : {}),
      })
    },
  )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm -C apps/api exec vitest run test/mcp-contexts.test.ts`
Expected: ALL pass (Task 4's 3 + these 4).

- [ ] **Step 5: Full API tests + typecheck, then commit**

Run: `corepack pnpm -C apps/api test` and `corepack pnpm -C apps/api typecheck`
Expected: all pass, both configs clean.

```bash
git add apps/api/src/mcp.ts apps/api/test/mcp-contexts.test.ts
git commit -m "feat(mcp): ask — open/follow-up/resume a context session, wait-first"
```

---

### Task 6: the async behaviors — wake, follow-up, closed, rate cap

Tests-only task: the blocking wait wakes on the settle event; a follow-up re-opens the same session; a closed session refuses with a pointer; the ask cap trips a loop. All against the code from Tasks 1, 3, 5.

**Files:**
- Test: `apps/api/test/mcp-contexts.test.ts` (append a describe block; extend imports)

**Interfaces:**
- Consumes: everything Tasks 1-5 produced; `inMemoryRateLimiters` from `../src/lib/rate-limit` (add to imports).

- [ ] **Step 1: Write the tests**

Add `import { inMemoryRateLimiters } from "../src/lib/rate-limit"` to the test file's imports, then append:

```ts
describe("ask({wait}) — the settle wake and the session loop", () => {
  // The workspace-policy flip every case here needs (dev is creator; the MCP
  // caller acts for owner, a plain member).
  const openPolicy = async (app: App, cxId: string) =>
    expect(
      (await app.request(`/v1/contexts/${cxId}/access`, jsonAs(as(dev.email), { ask_policy: "workspace" }))).status,
    ).toBe(200)

  it("blocks, then wakes the instant the runner answers — not at timeout", async () => {
    const backplane = createInProcessBackplane()
    const { app, cx, ownerToken, answeringToken } = await setup("mcx-wake", { backplane })
    await openPolicy(app, cx.id)
    const opened = await call(app, ownerToken, "ask", { context: "Analytics", question: "Q?", wait: 0 })
    const started = Date.now()
    const waiting = call(app, ownerToken, "ask", { session_id: opened.session_id, wait: 20 })
    // A beat for the waiter to subscribe, then the runner settles over REST.
    await new Promise((r) => setTimeout(r, 150))
    expect(
      (await answerAs(app, answeringToken, opened.session_id, { body_md: "Here.", state: "answered" })).status,
    ).toBe(201)
    const res = await waiting
    // Well under the 20s wait — the wake did it, not the timeout. (If this
    // asserts flaky in CI, the bound is the thing to loosen, never the wake.)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(res.state).toBe("answered")
    expect(res.answer).toMatchObject({ body_md: "Here." })
  })

  it("a follow-up rides the same session and re-opens it; closed refuses with a pointer", async () => {
    const { app, cx, ownerToken, answeringToken } = await setup("mcx-follow")
    await openPolicy(app, cx.id)
    const opened = await call(app, ownerToken, "ask", { context: "Analytics", question: "Q?", wait: 0 })
    expect(
      (await answerAs(app, answeringToken, opened.session_id, { body_md: "A.", state: "answered" })).status,
    ).toBe(201)
    const follow = await call(app, ownerToken, "ask", {
      session_id: opened.session_id,
      question: "And why?",
      wait: 0,
    })
    expect(follow.state).toBe("open")
    // The asker closes in the console; the agent's next follow-up is refused
    // with the reopen pointer (same 409 semantics the REST path has).
    expect(
      (
        await app.request(`/v1/sessions/${opened.session_id}`, {
          ...jsonAs(as(owner.email), { state: "closed" }),
          method: "PATCH",
        })
      ).status,
    ).toBe(200)
    const refused = await callRaw(app, ownerToken, "ask", {
      session_id: opened.session_id,
      question: "still there?",
      wait: 0,
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain("closed")
  })

  it("the ask cap trips a looping agent; the check mode stays uncapped", async () => {
    const { app, cx, ownerToken } = await setup("mcx-cap", {
      rateLimit: true,
      rateLimiters: inMemoryRateLimiters({ askRate: 2 }),
    })
    await openPolicy(app, cx.id)
    const first = await call(app, ownerToken, "ask", { context: "Analytics", question: "1", wait: 0 })
    await call(app, ownerToken, "ask", { context: "Analytics", question: "2", wait: 0 })
    const third = await callRaw(app, ownerToken, "ask", { context: "Analytics", question: "3", wait: 0 })
    expect(third.isError).toBe(true)
    expect(third.text).toContain("Rate limit")
    // Reads don't spend the budget: checking a session still works while capped.
    const check = await call(app, ownerToken, "ask", { session_id: first.session_id, wait: 0 })
    expect(check.state).toBe("open")
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `corepack pnpm -C apps/api exec vitest run test/mcp-contexts.test.ts`
Expected: ALL pass. If the wake test fails: first check Task 1's publishes reach `` `u:${asker_id}` `` with the shared `backplane` dep (the test injects it into `makeAuthedApp`), and that `ask`'s wait loop uses `ctx.bus.waitFor` (present on the in-process backplane).

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/mcp-contexts.test.ts
git commit -m "test(mcp): the ask wake, follow-up/closed loop, and the ask cap"
```

---

### Task 7: full verification + docs alignment

**Files:**
- Modify: `docs/plans/mcp-contexts-ask.md` (status line)

- [ ] **Step 1: Run the whole verification surface**

```bash
corepack pnpm -C apps/api test
corepack pnpm -C apps/api typecheck
corepack pnpm check
corepack pnpm -C apps/web typecheck
```

Expected: API tests all green; both API tsconfigs clean; biome reports only the 3 pre-existing main warnings; web typecheck clean (nothing web-facing changed — this is the proof).

- [ ] **Step 2: Confirm the REST surface is schema-identical**

Run: `git diff main -- apps/api/openapi.json`
Expected: empty (the contexts route changes are publishes only; if the file drifted, a route schema was accidentally touched — fix that, don't regenerate).

- [ ] **Step 3: Flip the spec status**

In `docs/plans/mcp-contexts-ask.md`, change the status line to:

```markdown
**Status:** implemented on `feat/mcp-contexts-ask` (design approved 2026-07-17).
```

- [ ] **Step 4: Commit**

```bash
git add docs/plans/mcp-contexts-ask.md
git commit -m "docs(plans): mark the MCP contexts ask surface implemented"
```

---

## Plan Self-Review (completed)

- **Spec coverage:** decisions 1-4 → Tasks 4-5 (surface + gating + wait-first); wake signal incl. close-wakes → Task 1; `canUserAskContext` → Task 2; askLimiter → Task 3 (+ Task 6 test); errors/edges (miss naming, closed, offline note, leak-proof session miss, no-human refusal) → Tasks 4-5 tests; testing section's four bullets → Tasks 1, 4, 5, 6. Deliberately out of scope per spec: provenance, console event adoption, catch_up mention.
- **Placeholders:** none; every step carries the code or the exact command.
- **Type consistency:** `canUserAskContext(userId, x)` (Tasks 2/4/5), `askLimiter`/`askRate` (Tasks 3/5/6), `session.settled` payload `{ session_id, state }` on `` `u:<asker_id>` `` (Tasks 1/5/6), response fields `session_id/context/state/answer/transcript/note` (Tasks 5/6) — all aligned.
