# Guided Conversational Context Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "New context" becomes a conversation with Derive on the existing chat machinery: the model interviews the user, writes the manifest, and creates the context; the manifest/short-id/runner-token concepts disappear from the default path.

**Architecture:** A new attended-chat purpose (`context_builder`) rides `runChatTurn` with its own system prompt and a scoped tool surface (`find`, `read`, plus two new loop tools `draft_manifest` and `create_context_from_draft`). The draft card payload is persisted on the agent message's `meta.card` and rendered by a new `ContextCard` component inside the shared `ChatThread`. Spec: `docs/superpowers/specs/2026-08-05-contexts-guided-create-design.md`.

**Tech Stack:** Hono + zod routes (`apps/api`), `packages/core` publish/ports, TanStack Router + React (`apps/web`), Vitest (node env only for web — no component render tests; Playwright smoke in `apps/web/e2e`).

## Global Constraints

- Copy rule (spec): conversation flow and context card copy must never contain "manifest", "short id", "runner token", or "serve". Exception: the expert door label "I already have a manifest" (excluded by test id `builder-expert-door`).
- Builder rides the exact chat gates: `chatArrival` (chat-gate.ts) — `chatBeta` org setting, allowlist, membership, rate, budget, model. No new gate semantics.
- No new DB tables or columns. The builder session is a `context_session` row with `subject_ref: '{"kind":"context_builder"}'`.
- Feature parity: with no model configured, the page still works — agent door + expert form.
- Run everything with `corepack pnpm` from the worktree root `/Users/connor/Downloads/Claude/Derive/derive/.claude/worktrees/contexts-guided-create`. Formatting: `corepack pnpm check:fix` before commit (pre-commit runs `pnpm run ci`).
- Commit messages follow repo style (`feat(scope): lowercase summary`), each ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- This repo is PUBLIC: no customer names, no internal URLs in code/comments/commits (see CLAUDE.md).

---

### Task 1: Builder purpose in the chat turn

**Files:**
- Create: `apps/api/src/lib/context-builder-prompt.ts`
- Modify: `apps/api/src/lib/chat-turn.ts` (interface at L45, `systemPrompt` at L117-142)
- Test: `apps/api/test/context-builder-turn.test.ts`

**Interfaces:**
- Consumes: `runChatTurn(deps: ChatTurnDeps, input: ChatTurnInput)` (chat-turn.ts:148), `ChatTurnInput` (chat-turn.ts:45).
- Produces: `ChatTurnInput.purpose?: "context_builder"` (absent = today's workspace prompt, unchanged); `export const CONTEXT_BUILDER_PROMPT: (input: { workspaceName: string; askerName: string | null }) => string` in context-builder-prompt.ts. Task 4 passes `purpose` from the serve branch.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/context-builder-turn.test.ts
import { describe, expect, it } from "vitest"
import { runChatTurn, type ChatTurnInput } from "../src/lib/chat-turn"

const baseInput = (purpose?: "context_builder"): ChatTurnInput => ({
  session: {
    id: "ses_t", org_id: "default", context_id: null, context_version: null,
    asker_id: "u-1", subject_ref: null, state: "open",
    created_at: new Date().toISOString(), settled_at: null,
  } as ChatTurnInput["session"],
  transcript: [
    {
      id: "sm_1", session_id: "ses_t", author_kind: "asker", author_id: "u-1",
      body_md: "I want a helper for our pricing docs", meta: null,
      created_at: new Date().toISOString(),
    } as ChatTurnInput["transcript"][number],
  ],
  tools: { tools: [], execute: async () => ({}), skills: [] },
  workspaceName: "Acme",
  asker: { name: "Pat", role: "editor" },
  skills: [],
  ...(purpose ? { purpose } : {}),
})

describe("chat turn purpose", () => {
  it("context_builder swaps in the builder prompt", async () => {
    let system = ""
    await runChatTurn(
      { model: { id: "m", label: "M", isDefault: true,
        callModel: async (args: { system: string }) => {
          system = args.system
          return { text: "hi", toolUses: [], costUsd: null, done: true }
        } } },
      baseInput("context_builder"),
    )
    expect(system).toContain("You are helping Pat set up a context")
    // The prompt necessarily names the draft_manifest tool; the jargon ban applies to
    // what the model SAYS, so assert the ban instruction itself is in the voice.
    expect(system).toContain('Never use the words "manifest"')
  })

  it("absent purpose keeps the workspace prompt", async () => {
    let system = ""
    await runChatTurn(
      { model: { id: "m", label: "M", isDefault: true,
        callModel: async (args: { system: string }) => {
          system = args.system
          return { text: "hi", toolUses: [], costUsd: null, done: true }
        } } },
      baseInput(),
    )
    expect(system).not.toContain("set up a context")
  })
})
```

Note: if `callModel`'s first parameter is not `{ system: string }`, read `apps/api/src/lib/agent-loop.ts` for `AgentLoopInput["callModel"]`'s exact argument shape and adjust the capture — the assertion targets stay the same.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && corepack pnpm vitest run test/context-builder-turn.test.ts`
Expected: FAIL — `purpose` is not a known property / builder text absent.

- [ ] **Step 3: Implement**

`apps/api/src/lib/context-builder-prompt.ts` (new):

```ts
// The builder interview's voice. The words "manifest", "short id", "runner
// token" and "serve" are banned from anything the model may say to the user —
// the whole point of this flow is that those concepts stay internal. The
// instructions here may name tools (draft_manifest) because tool names are
// never rendered to the user (chat-thread renders a prose trace).
export const CONTEXT_BUILDER_PROMPT = (input: {
  workspaceName: string
  askerName: string | null
}): string => `You are Derive, helping ${input.askerName ?? "a teammate"} set up a context in the ${input.workspaceName} workspace. A context is a packaged helper their team's agents can consult.

Interview them like a colleague, not a form. Open by asking what the context should know or do, as if they were briefing a new teammate. Ask at most three follow-up questions, and only when the answer genuinely changes what you build. Use find and read to look at any workspace documents they mention or that obviously fit, and suggest them.

When you know enough, call draft_manifest with everything you have inferred. Present the result conversationally in one or two sentences; the card shows the details. If they ask for changes, call draft_manifest again with the revision. When they confirm, call create_context_from_draft and tell them it is ready and what to do next (teammates' agents can consult it now).

Never use the words "manifest", "short id", "runner token", or "serve" when talking to them. Describe things by what they do: "what it knows", "who can ask it", "ready for your team's agents".

If they describe something that should answer questions or do work on its own (not just be consulted), set kind to "worker" in the draft; the card explains what that means. Default to "knowledge".`
`

In `apps/api/src/lib/chat-turn.ts`:

```ts
// In ChatTurnInput (after `skills`):
  /** Which system prompt this turn speaks with. Absent = the workspace chat
   *  voice. "context_builder" = the guided create-a-context interview. */
  purpose?: "context_builder"
```

and in `systemPrompt` (L117), first line:

```ts
import { CONTEXT_BUILDER_PROMPT } from "./context-builder-prompt"

const systemPrompt = (input: ChatTurnInput): string => {
  if (input.purpose === "context_builder")
    return CONTEXT_BUILDER_PROMPT({
      workspaceName: input.workspaceName,
      askerName: input.asker.name,
    })
  // ...existing template unchanged below
```

- [ ] **Step 4: Run tests**

Run: `cd apps/api && corepack pnpm vitest run test/context-builder-turn.test.ts test/chat-attended.test.ts`
Expected: PASS (both — the second proves the default path is untouched).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/context-builder-prompt.ts apps/api/src/lib/chat-turn.ts apps/api/test/context-builder-turn.test.ts
git commit -m "feat(api): chat turns can speak as the context builder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Extract the create-context core

**Files:**
- Create: `apps/api/src/lib/create-context.ts`
- Modify: `apps/api/src/mcp-tools/automate.ts:178-215` (the `create_context` branch becomes a call to the new helper)
- Test: `apps/api/test/create-context-core.test.ts`

**Interfaces:**
- Consumes: `meta.createAgent`, `meta.createContext` (`packages/core/src/ports.ts:1412`, `NewContext` at ports.ts:2753), `newId`, `sha256` — copy the exact mint recipe from `apps/api/src/routes/contexts.ts:1110-1124` / `automate.ts:178-215` (dk_agt_ token = `"dk_agt_" + two hex UUIDs`, `managed: 1`, name-collision retry with 4-char suffix).
- Produces:

```ts
export interface CreateContextCoreInput {
  orgId: string
  userId: string
  name: string
  manifestArtifactId: string           // internal artifact id, not short_id
  maxRunMs?: number
  maxConcurrency?: number
}
export interface CreateContextCoreResult {
  context: ContextRecord
  agentId: string
  /** Present so the HTTP route can keep returning it once; the builder and automate discard it. */
  agentToken: string
}
export const createContextCore = async (
  meta: MetaStore, input: CreateContextCoreInput,
): Promise<CreateContextCoreResult>
```

Duplicate-name behavior: throw the same conflict error shape automate.ts produces today (read the branch and preserve it verbatim — do not invent a new error type). Task 3 consumes this.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/create-context-core.test.ts
import { describe, expect, it } from "vitest"
import { createContextCore } from "../src/lib/create-context"
import { makeAuthedApp, as, publishAs } from "./helpers"

const owner = { id: "u-ow", email: "ow@x.com", name: "Ow" }

describe("createContextCore", () => {
  it("mints a managed agent and writes the context row", async () => {
    const { app, meta } = makeAuthedApp("ctx-core", [owner])
    await app.request("/v1/me", { headers: as(owner.email) })
    const pub = await (await publishAs(app, "# A manifest", {}, as(owner.email))).json()
    const artifact = await meta.getArtifactByShortId(pub.short_id)

    const made = await createContextCore(meta, {
      orgId: "default", userId: owner.id, name: "Pricing Helper",
      manifestArtifactId: artifact!.id,
    })
    expect(made.context.name).toBe("Pricing Helper")
    expect(made.agentToken).toMatch(/^dk_agt_/)
    const agent = await meta.getAgent(made.agentId)
    expect(agent?.managed).toBeTruthy()
  })

  it("second create with the same name conflicts", async () => {
    const { app, meta } = makeAuthedApp("ctx-core-dup", [owner])
    await app.request("/v1/me", { headers: as(owner.email) })
    const pub = await (await publishAs(app, "# M", {}, as(owner.email))).json()
    const artifact = await meta.getArtifactByShortId(pub.short_id)
    const input = { orgId: "default", userId: owner.id, name: "Dup", manifestArtifactId: artifact!.id }
    await createContextCore(meta, input)
    await expect(createContextCore(meta, input)).rejects.toThrow()
  })
})
```

If `meta.getArtifactByShortId` / `meta.getAgent` differ in name, find the real accessors in `packages/core/src/ports.ts` (search `getArtifact`, `getAgent`) and use those — do not add new port methods.

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && corepack pnpm vitest run test/create-context-core.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — move the body of automate.ts's `create_context` branch into `createContextCore` (mint, retry-on-name-collision, `meta.createContext`, unwind the minted agent if the context insert conflicts — the route at contexts.ts:1148 shows the unwind), then make automate.ts call it and discard `agentToken`. Behavior identical; this is an extraction, not a redesign.

- [ ] **Step 4: Run the neighbors** — `cd apps/api && corepack pnpm vitest run test/create-context-core.test.ts test/mcp.test.ts test/contexts-managed-agent.test.ts` → PASS all.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/create-context.ts apps/api/src/mcp-tools/automate.ts apps/api/test/create-context-core.test.ts
git commit -m "refactor(api): one create-context core for automate and the builder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: The builder tool surface

**Files:**
- Create: `apps/api/src/lib/context-builder-tools.ts`
- Test: `apps/api/test/context-builder-tools.test.ts`

**Interfaces:**
- Consumes: `buildChatTools(ctx, who, only)` + `ChatToolSurface` + `ChatPrincipal` (chat-tools.ts:220/68/196), `publish` (`packages/core/src/publish.ts:262`), `createContextCore` (Task 2), `jsonSchemaOf` pattern (chat-tools.ts:168 — reuse the module's exported helper if exported, else replicate the two-line `z.toJSONSchema` call).
- Produces:

```ts
export interface ContextDraft {
  name: string
  description: string
  kind: "knowledge" | "worker"
  knows: string[]           // plain-language scope bullets
  answers: string           // how it answers
  wont: string[]            // honest limits
  manifest_md: string       // the full manifest the model wrote (internal)
  source_short_ids: string[]
}
export interface BuilderCard {
  draft: Omit<ContextDraft, "manifest_md">
  created?: { context_id: string; name: string }
}
export interface BuilderToolSurface extends ChatToolSurface {
  /** The card produced by the LAST draft_manifest / create_context_from_draft
   *  call in this turn, for the reply writer to persist on meta.card. */
  card(): BuilderCard | null
}
export const buildContextBuilderTools = (
  ctx: AppContext, who: ChatPrincipal,
): BuilderToolSurface
```

Tool behavior:
- `draft_manifest(input: ContextDraft)` → stores the draft in closure, returns `{ ok: true, card: <BuilderCard> }`.
- `create_context_from_draft({})` → requires a stored draft (error `{ error: "call draft_manifest first" }` otherwise); publishes the manifest via `publish(meta, blobs, { bytes, filename: "manifest.md", isBundle: false, orgId: who.org, title: draft.name + " — context instructions", authorId: who.user.id, source: "api" })` with a header comment prepended to `manifest_md`:

```
<!-- This document is the instruction set for the "<name>" context in Derive.
     Agents read it to learn what the context knows and how it should answer.
     Edit it like any document; the context uses the newest version. -->
```

then calls `createContextCore` with the published artifact's id, discards the token, updates the closure card with `created`, and returns `{ ok: true, context_id, card }`.
- The surface's `tools` = the two builder tools + `buildChatTools(ctx, who, new Set(["find", "read"])).tools`; `execute` routes the two new names first, then delegates.

- [ ] **Step 1: Write the failing tests** — in `apps/api/test/context-builder-tools.test.ts`, using `makeAuthedApp` for a real `ctx` (see how chat-tools tests obtain `AppContext`; mirror it):

```ts
import { describe, expect, it } from "vitest"
import { buildContextBuilderTools } from "../src/lib/context-builder-tools"
import { makeAuthedApp, as } from "./helpers"

const owner = { id: "u-b", email: "b@x.com", name: "B" }
const draft = {
  name: "Pricing Helper", description: "Answers pricing questions",
  kind: "knowledge" as const,
  knows: ["The pricing page", "The FAQ"], answers: "Short, with links",
  wont: ["Legal advice"], manifest_md: "# Pricing Helper\n...", source_short_ids: [],
}

describe("builder tool surface", () => {
  it("draft then create publishes the doc and creates the context", async () => {
    const { appCtx, app, meta } = await (async () => {
      const made = makeAuthedApp("builder-tools", [owner])
      await made.app.request("/v1/me", { headers: as(owner.email) })
      return { appCtx: made.ctx, ...made }
    })()
    const surface = buildContextBuilderTools(appCtx, {
      org: "default", user: { id: owner.id, name: owner.name }, seatRole: "owner",
    })
    expect(surface.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["draft_manifest", "create_context_from_draft", "find", "read"]),
    )

    await surface.execute("draft_manifest", draft)
    expect(surface.card()?.draft.name).toBe("Pricing Helper")
    expect(surface.card()?.created).toBeUndefined()

    const out = (await surface.execute("create_context_from_draft", {})) as {
      ok: boolean; context_id: string
    }
    expect(out.ok).toBe(true)
    const ctxRow = await meta.getContext(out.context_id)
    expect(ctxRow?.name).toBe("Pricing Helper")
    expect(surface.card()?.created?.context_id).toBe(out.context_id)
  })

  it("create without a draft is a plain error, not a throw", async () => {
    const made = makeAuthedApp("builder-tools-2", [owner])
    await made.app.request("/v1/me", { headers: as(owner.email) })
    const surface = buildContextBuilderTools(made.ctx, {
      org: "default", user: { id: owner.id, name: owner.name }, seatRole: "owner",
    })
    const out = await surface.execute("create_context_from_draft", {})
    expect(out).toEqual({ error: "call draft_manifest first" })
  })
})
```

If `makeAuthedApp` does not return the `AppContext` as `.ctx`, read `apps/api/test/helpers.ts:304` for what it does return and reach the context the way `chat-tools.test.ts` does; `meta.getContext` likewise — find the real accessor in ports.ts.

- [ ] **Step 2: Run to verify failure** — `cd apps/api && corepack pnpm vitest run test/context-builder-tools.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `context-builder-tools.ts` per the interface above. Zod schemas inline (`z.object({ name: z.string().trim().min(1).max(80), ... })` — reuse the length caps from the create route at contexts.ts:1063 so a draft can never fail the create). The manifest publish must NOT call `afterPublish` (a builder manifest needs no unfurl/webhook fanout on creation; the create route's own path doesn't run it either).

- [ ] **Step 4: Run tests** — same command → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/context-builder-tools.ts apps/api/test/context-builder-tools.test.ts
git commit -m "feat(api): the context builder's tool surface — draft, then create

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Builder session route and serve branch

**Files:**
- Modify: `apps/api/src/routes/contexts.ts` — add `POST /v1/context-builder-session` next to `POST /v1/chat-session` (L1982); branch the attended serve path (the `serveAttended` call chain around L371-404) on the session's `subject_ref`; persist `meta.card`.
- Test: `apps/api/test/context-builder-session.test.ts`

**Interfaces:**
- Consumes: `chatArrival` (chat-gate.ts:55), `createSessionWithMessage` (ports.ts:1452), Task 1's `purpose`, Task 3's `buildContextBuilderTools`.
- Produces:
  - Route `POST /v1/context-builder-session`, body `z.object({ workspace: z.string(), body_md: z.string().min(1).max(20_000), model: z.string().optional() })`, response `201 { session, messages }` — identical envelope to `/v1/chat-session` so the web client's session polling works unchanged. The session row is created with `subject_ref: JSON.stringify({ kind: "context_builder" })`.
  - `BUILDER_SUBJECT = '{"kind":"context_builder"}'` exported from the routes module (or a small shared module if routes don't export) — the serve branch and web never re-derive the string two ways.
  - Serve branch: when a claimed attended session's `subject_ref` parses to `{ kind: "context_builder" }`, the turn runs with `purpose: "context_builder"` and `buildContextBuilderTools(ctx, who)`; after the turn, the agent message `meta` gains `card: surface.card()` when non-null (alongside the existing `{ outcome, cost_micro_usd, model, tools }`).
  - Follow-ups arrive through the existing `POST /v1/sessions/{id}/messages` untouched — the branch keys off the session row, not the route.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/context-builder-session.test.ts
import { describe, expect, it } from "vitest"
import { as, makeAuthedApp } from "./helpers"

const owner = { id: "u-ow", email: "ow@x.com", name: "Ow" }
const draftArgs = {
  name: "Pricing Helper", description: "Answers pricing questions",
  kind: "knowledge", knows: ["Pricing page"], answers: "Short",
  wont: ["Legal advice"], manifest_md: "# Pricing Helper", source_short_ids: [],
}

/** A model scripted turn-by-turn: first call draft_manifest, then prose. */
const scripted = () => {
  let call = 0
  return async () => {
    call++
    if (call === 1)
      return {
        text: "", costUsd: null, done: false,
        toolUses: [{ id: "t1", name: "draft_manifest", input: draftArgs }],
      }
    return { text: "Here's the plan — look right?", toolUses: [], costUsd: null, done: true }
  }
}

describe("builder session", () => {
  it("creates a builder session and the reply carries the card", async () => {
    const { app, meta } = makeAuthedApp("builder-ses", [owner], undefined, {
      deps: { callModel: scripted() },
    })
    await app.request("/v1/me", { headers: as(owner.email) })
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")), chatBeta: true,
    })

    const res = await app.request("/v1/context-builder-session", {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ workspace: "default", body_md: "A helper for pricing docs" }),
    })
    expect(res.status).toBe(201)
    const { session } = await res.json()

    // Attended serve runs in ctx.background; poll the session until settled.
    let msgs: { author_kind: string; meta: string | null }[] = []
    for (let i = 0; i < 50; i++) {
      const got = await (await app.request(`/v1/sessions/${session.id}`, {
        headers: as(owner.email),
      })).json()
      msgs = got.messages
      if (msgs.some((m) => m.author_kind === "agent")) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const agent = msgs.find((m) => m.author_kind === "agent")
    expect(agent).toBeTruthy()
    const meta2 = JSON.parse(agent!.meta ?? "{}")
    expect(meta2.card?.draft?.name).toBe("Pricing Helper")
    expect(meta2.card?.draft?.manifest_md).toBeUndefined() // internal, never shipped to the client
  })

  it("without chatBeta the route refuses like chat does", async () => {
    const { app } = makeAuthedApp("builder-ses-off", [owner], undefined, {
      deps: { callModel: scripted() },
    })
    await app.request("/v1/me", { headers: as(owner.email) })
    const res = await app.request("/v1/context-builder-session", {
      method: "POST",
      headers: { ...as(owner.email), "content-type": "application/json" },
      body: JSON.stringify({ workspace: "default", body_md: "hi" }),
    })
    expect(res.status).toBe(404) // not_enabled maps to 404, same as /v1/chat-session
  })
})
```

Adjust the scripted `callModel`'s tool-use return shape to `AgentLoopInput["callModel"]`'s real contract (read `apps/api/src/lib/agent-loop.ts`; `chat-writes.test.ts` likely has a scripted tool-use example to copy exactly).

- [ ] **Step 2: Run to verify failure** — `cd apps/api && corepack pnpm vitest run test/context-builder-session.test.ts` → FAIL (404 route not found on the first test).

- [ ] **Step 3: Implement.** Copy the `/v1/chat-session` handler (L1982) as `/v1/context-builder-session` with two diffs: `subject_ref: BUILDER_SUBJECT` on the created session, and no `subject_ref: null` assumptions downstream. In the serve chain, where the turn input is assembled (L371-404 neighborhood): parse `session.subject_ref`; on `{kind:"context_builder"}` build the surface with `buildContextBuilderTools`, pass `purpose: "context_builder"`, and when writing the agent reply merge `...(surface.card() ? { card: stripInternal(surface.card()) } : {})` into the persisted meta, where `stripInternal` removes `manifest_md` from the draft. OpenAPI: mirror however `/v1/chat-session` declares its response schema so the generated client picks it up.

- [ ] **Step 4: Run tests** — `cd apps/api && corepack pnpm vitest run test/context-builder-session.test.ts test/chat-attended.test.ts test/chat-workspace.test.ts` → PASS all three.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/contexts.ts apps/api/test/context-builder-session.test.ts
git commit -m "feat(api): the guided context-builder conversation, on the attended chat rail

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Client types and API method

**Files:**
- Modify: `apps/web/src/api.ts` (near `createContext` at L1011)
- Regenerate: `apps/web/src/api-types.ts` via `cd apps/web && corepack pnpm gen:api-types` (regenerates from `apps/api/openapi.json`; if that JSON is itself generated, find the api-side script — `node scripts/check-api-types.mjs` in root package.json names the checker; run whatever it checks against).
- Test: covered by `lint:api-types` in CI; no new unit test.

**Interfaces:**
- Produces:

```ts
// apps/web/src/api.ts, next to createContext:
  createBuilderSession: (input: { workspace: string; body_md: string; model?: string }) =>
    f("/v1/context-builder-session", opts(input)).then(j) as Promise<{
      session: { id: string }
      messages: unknown[]
    }>,
```

- and the meta shape the web reads (Task 6 imports this from one place):

```ts
// apps/web/src/components/chat/builder-card.ts (new, types only)
export interface BuilderCardDraft {
  name: string; description: string; kind: "knowledge" | "worker"
  knows: string[]; answers: string; wont: string[]; source_short_ids: string[]
}
export interface BuilderCardMeta {
  draft: BuilderCardDraft
  created?: { context_id: string; name: string }
}
```

- [ ] **Step 1: Add the client method and types** (above, verbatim).
- [ ] **Step 2: Regenerate api-types and verify** — `cd apps/web && corepack pnpm gen:api-types && cd ../.. && corepack pnpm lint:api-types` → PASS. `corepack pnpm typecheck` → PASS.
- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/api-types.ts apps/web/src/components/chat/builder-card.ts
git commit -m "feat(web): client surface for the context-builder session

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: The context card in the thread, and the copy module

**Files:**
- Create: `apps/web/src/components/chat/context-card.tsx`
- Create: `apps/web/src/pages/context/builder-copy.ts`
- Modify: `apps/web/src/components/chat/chat-thread.tsx` (`ChatMessage` meta at L16; `Bubble` at L188)
- Test: `apps/web/src/pages/context/builder-copy.test.ts`

**Interfaces:**
- Consumes: `BuilderCardMeta` (Task 5), `ChatMessage` (chat-thread.tsx:16).
- Produces:
  - `ChatMessage["meta"]` gains `card?: BuilderCardMeta | null`.
  - `export function ContextCard({ card }: { card: BuilderCardMeta })` — rendered by `Bubble` after the prose when `msg.meta?.card` is set. Card sections: name + description; "What it knows" (bullets, each `source_short_ids` entry rendered as an artifact link `/artifacts/${shortId}`); "How it answers"; "What it won't do"; kind line (knowledge: `BUILDER_COPY.kindKnowledge`; worker: `BUILDER_COPY.kindWorker`). When `card.created` is set the footer swaps to a link: "Ready — open **{name}**" → `/contexts/${created.context_id}`. Container matches the console rail cards: `rounded-xl border bg-card p-3.5`, `data-testid="builder-context-card"`.
  - `builder-copy.ts` exports every user-visible builder string:

```ts
export const BUILDER_COPY = {
  pageTitle: "New context",
  intro: "Tell Derive what this context should know or do — like briefing a new teammate.",
  composerPlaceholder: "What should this context know or do?",
  agentDoorTitle: "Prefer your own agent to build it?",
  agentDoorBody: "Copy this prompt into Claude Code or any connected agent, and it will interview you and set the context up here.",
  agentDoorPrompt: [
    "I want to create a new context in our Derive workspace.",
    "Interview me briefly about what it should know or do, who should be able",
    "to ask it questions, and which existing documents it should learn from.",
    "Then use the Derive MCP tools to create it: publish an instructions",
    "document from what I told you, then automate {action: \"create_context\"}",
    "with its short id. When you're done, give me the link to the new context.",
  ].join(" "),
  expertDoor: "I already have a manifest",
  kindKnowledge: "Your team's agents can consult this as soon as it's created.",
  kindWorker: "This one will also take on work itself. Answers come from whoever runs it — you can do that from your own agent session, or set up a dedicated helper later on the context's page.",
  createdPrefix: "Ready — open",
  degradedNotice: "This workspace doesn't have built-in chat turned on, so Derive can't interview you here. Your agent can still build it:",
  statusOnline: "Online — it can take on work right now.",
  statusOffline: "Offline — asking it to do work will wait until it's back. Reading what it knows always works.",
  statusNever: "Not serving yet — teammates' agents can still read what it knows.",
} as const
```

  - The banned-words test (the spec's literal assertion):

```ts
// apps/web/src/pages/context/builder-copy.test.ts
import { describe, expect, it } from "vitest"
import { BUILDER_COPY } from "./builder-copy"

// The reason this flow exists: the concepts a first-timer fell over must not
// appear in anything the flow says to them. The agent prompt (spoken to an
// agent) and the expert door label are the two deliberate exceptions.
const BANNED = [/manifest/i, /short.?id/i, /runner.?token/i, /\bserve\b/i]
const EXEMPT = new Set(["agentDoorPrompt", "expertDoor"])

describe("builder copy stays jargon-free", () => {
  for (const [key, value] of Object.entries(BUILDER_COPY)) {
    if (EXEMPT.has(key)) continue
    it(key, () => {
      for (const pattern of BANNED) expect(value).not.toMatch(pattern)
    })
  }
})
```

- [ ] **Step 1: Write the copy module + failing test** (the test passes trivially once the module exists — write the test first, watch it fail on missing module, then add the module).
- [ ] **Step 2: Run** — `cd apps/web && corepack pnpm vitest run src/pages/context/builder-copy.test.ts` → PASS after the module lands.
- [ ] **Step 3: Implement `ContextCard` and the `Bubble` hook-in** (render after the prose div when `msg.meta?.card`; import type only from `builder-card.ts`). No component render test (repo has none; Playwright covers it in Task 8).
- [ ] **Step 4: Typecheck** — `corepack pnpm typecheck` → PASS. Also `cd apps/web && corepack pnpm vitest run` → all web unit tests PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/context-card.tsx apps/web/src/pages/context/builder-copy.ts apps/web/src/pages/context/builder-copy.test.ts apps/web/src/components/chat/chat-thread.tsx
git commit -m "feat(web): the context card the builder conversation produces

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: The builder page, the two doors, and the rewired entry

**Files:**
- Create: `apps/web/src/pages/context/builder.tsx`
- Create: `apps/web/src/routes/contexts.new.tsx`
- Create: `apps/web/src/pages/context/new-context-form.tsx` (the existing `NewContext` moves here verbatim)
- Modify: `apps/web/src/pages/context/index.tsx` (button navigates to `/contexts/new`; `NewContext` import moves; intro + empty-state copy; liveness hover titles)
- Modify: `apps/web/src/pages/context/console.tsx` (`RunnerLiveness` at L503 gains the same `title` hovers)

**Interfaces:**
- Consumes: `useChatSession({ open, followUp, resetKey })` (`apps/web/src/components/chat/use-chat-session.ts:59` — pass builder `open`/`followUp` closures that call `api.createBuilderSession` / the existing follow-up POST; read the hook first: mirror how `ChatPage` builds these two callbacks, swapping the open endpoint), `ChatThread`, `ChatComposer`, `BUILDER_COPY` (Task 6), `api.getChatModels` equivalent (`GET /v1/chat/models` — find the existing client method near api.ts's chat methods; ChatPage already calls it).
- Produces: route `/contexts/new` rendering `ContextBuilderPage`:
  - Header: `BUILDER_COPY.pageTitle` + `intro`.
  - Main: `ChatThread` + `ChatComposer` (placeholder `composerPlaceholder`), wired exactly like ChatPage but opening via `api.createBuilderSession({ workspace, body_md })`.
  - Right/below: the agent door card — `agentDoorTitle`, `agentDoorBody`, the prompt in a `<code>` block with a copy button (`navigator.clipboard.writeText`, toast "Prompt copied" — same pattern as the token copy button at index.tsx:245), `data-testid="builder-agent-door"`.
  - Footer link `data-testid="builder-expert-door"`, label `BUILDER_COPY.expertDoor`, toggling the relocated `NewContextForm`.
  - Degraded mode: if the models fetch errors or returns none (the chat gate's `not_enabled` → 404), hide the composer, show `degradedNotice` above the agent door, expert door unchanged.
- Contexts index changes: "New context" button → `nav({ to: "/contexts/new" })` (keep testid `contexts-new-toggle`); page intro becomes "A context is a helper you set up once — what it knows, how it answers — that your team and their agents can ask questions or hand work."; empty state description becomes "Describe what it should know, and Derive builds it with you." with the button as the action; the liveness dots get `title={BUILDER_COPY.statusOnline | statusOffline | statusNever}`.

- [ ] **Step 1: Build the page and route** (no unit test — page components are Playwright territory; the pure copy is already tested). Read `apps/web/src/pages/chat/index.tsx:103-286` first and mirror its `useChatSession` wiring, replacing the open call and dropping the model picker and history dropdown (a builder conversation is one-shot; `resetKey` on unmount).
- [ ] **Step 2: Move `NewContext` → `new-context-form.tsx`**, export as `NewContextForm`, update the one import site (index.tsx:62 renders it only behind the expert door now — delete the `showCreate` block there entirely; the form lives on the builder page).
- [ ] **Step 3: Copy sweep** — index.tsx intro (L45-48), empty state (L87-91), dot hovers (index.tsx:128-131, console.tsx:503-534).
- [ ] **Step 4: Verify** — `corepack pnpm typecheck && cd apps/web && corepack pnpm vitest run` → PASS; `corepack pnpm run ci` from root → PASS (catches lint:testids, lint:frontend etc.).
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/context/ apps/web/src/routes/contexts.new.tsx
git commit -m "feat(web): New context is a conversation — two doors, no jargon

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Playwright smoke + full verify

**Files:**
- Create: `apps/web/e2e/context-builder.smoke.spec.ts`
- Test: itself

**Interfaces:**
- Consumes: the e2e fixtures (`apps/web/e2e/fixtures.ts` — `test(..., async ({ owner }) => ...)` pattern from `library-multi-select.smoke.spec.ts:29`); testids from Tasks 6-7 (`builder-agent-door`, `builder-expert-door`, `contexts-new-toggle`).

- [ ] **Step 1: Write the smoke spec**

```ts
import { expect } from "@playwright/test"
import { test } from "./fixtures"

// The builder page's static promise: both doors render without a model.
// (The conversation itself is model-backed and covered by API tests.)
test("New context opens the builder with both doors", async ({ owner }) => {
  await owner.goto("/contexts")
  await owner.getByTestId("contexts-new-toggle").click()
  await expect(owner).toHaveURL(/\/contexts\/new/)
  await expect(owner.getByTestId("builder-agent-door")).toBeVisible()
  await expect(owner.getByTestId("builder-expert-door")).toBeVisible()
})

test("the expert door reveals the classic form", async ({ owner }) => {
  await owner.goto("/contexts/new")
  await owner.getByTestId("builder-expert-door").click()
  await expect(owner.getByTestId("context-create-name")).toBeVisible()
  await expect(owner.getByTestId("context-create-manifest")).toBeVisible()
})
```

Read `apps/web/e2e/README.md` + `fixtures.ts` first: if the fixture exposes a page object differently (e.g. `({ page, owner })`), match the existing specs exactly.

- [ ] **Step 2: Run the smoke locally** — follow the run command in `apps/web/e2e/README.md` (the deck smoke spec's header comment usually names it). Expected: both tests PASS.
- [ ] **Step 3: Full gate** — from the worktree root: `corepack pnpm verify` (ci → typecheck → test:coverage). Known flake: apps/api coverage can time out a random test under load (passes in isolation) — rerun once before treating a timeout as real.
- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/context-builder.smoke.spec.ts
git commit -m "test(web): smoke the builder page's two doors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes (already applied)

- Spec coverage: conversation door (T1,3,4,7), model-written manifest + card (T3,4,6), inferred fork (`kind` in draft schema + card copy, T3/T6), agent door (T7 copy), degraded mode (T7), explainers (T7 copy sweep + dot hovers), copy test (T6), "indistinguishable from hand-created" (T2 reuses the same core), error handling (T3's no-draft error; transcript survival is chat semantics untouched).
- The builder never touches the MCP tool surface (PR #644 territory) — new tools exist only on the chat loop surface.
- Type consistency: `BuilderCard`/`BuilderCardMeta` defined once each (api side T3, web side T5) with the same shape minus `manifest_md`, which T4 strips before persisting.
