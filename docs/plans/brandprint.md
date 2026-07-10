# Brandprint

Status: draft spec, ready for review
Owner: Connor
Related prior art: `feat/house-style` (Anir, unmerged, 104 commits behind main)

## One line

Every team gets a **Brandprint**: their voice, style, and rules captured once, read automatically by any agent that works in Derive, and applied on demand to existing artifacts with a one-click **Rework** button.

## Why this exists

AI produces more work than a team can re-brief. Today, matching that output to a company's voice means re-explaining the brand in every prompt, or fixing tone and style by hand after the fact. Derive already keeps the work; Brandprint keeps the *taste*, so the work comes out on-brand from the first draft without anyone remembering to ask.

Two facts shape the whole design:

1. **Derive runs no inference of its own.** All model work is done by the user's connected agent (Claude Code, Codex, and so on) over MCP. Anything that needs a model has to route to that agent. Anything that is just storage can happen server-side with no model.
2. **Half of this already exists.** Anir's `feat/house-style` branch built the delivery layer (conventions resolved per workspace and per user, handed to agents over MCP). And Derive already has an "ask an agent" mechanism that hands a scoped change to a connected agent's pull inbox and gets back a reviewable revision. Brandprint is largely a composition of these two systems, not new plumbing.

## Naming

The user-facing name is **Brandprint**. Anir's branch calls it "House Style" in both copy and code. Because we are porting that branch forward by hand (see Port plan), we rename the code identifiers at the same time so the product name and the codebase never drift.

| Current (`house-style`) | New (`brandprint`) |
| --- | --- |
| `packages/core/src/house-style.ts` | `packages/core/src/brandprint.ts` |
| type `HouseStyle` | `Brandprint` |
| type `ThemeTokens` | `BrandprintTheme` |
| `resolveHouseStyle()` | `resolveBrandprint()` |
| `parseHouseStyle()` | `parseBrandprint()` |
| `houseStyleInstructions()` | `brandprintInstructions()` |
| `OrgSettings.houseStyle` | `OrgSettings.brandprint` |
| profile field `houseStyle` | `brandprint` |
| `MetaStore.getUserHouseStyle` | `getUserBrandprint` |
| MCP resource `dock://house-style/<id>` | `derive://brandprint/<id>` |
| web `settings/house-style-section.tsx` | `settings/brandprint-section.tsx` |
| tests `*house-style*` | `*brandprint*` |

## Goals

- A team can capture its Brandprint in under a minute, with no pre-existing documents and no agent connected.
- Any connected agent reads the Brandprint automatically before it creates or revises anything.
- A person can point at an existing artifact and get an on-brand version back in one click, then review it.
- Skipping any of this never dead-ends the user. It degrades to a clear "connect an agent" prompt.
- Non-technical users are first-class. Nothing here requires writing convention docs by hand or editing config.

## Non-goals

- Visual theme application (rendering artifacts with the Brandprint's palette and fonts). Anir captured theme tokens in the data model; applying them is his Phase B and stays out of scope here.
- Derive performing any inference itself. If a step needs a model, it routes to the connected agent.
- A live chat assistant inside Derive. The agent interaction is the existing asynchronous "hand off a task, get back a revision" shape, not a conversation.

## Settled decisions

1. **Authoring:** seed a starter Brandprint from a short intake (paste brand notes, a URL, or a sample doc). Stored as-is with no model; optional agent enrichment later.
2. **Onboarding:** the first person to set up a workspace's Brandprint gets a skippable step with a plain-language explanation. People joining a workspace that already has a Brandprint never see it and inherit it automatically.
3. **Rework output:** the reworked version follows the agent's grant (publish-capable posts a new version directly, lower grant files a proposal). Always a new version, so it is non-destructive and reversible via history.
4. **Foundation:** port Anir's Phase A forward onto current main (cherry-pick the pure core, re-apply the wiring by hand), renamed to Brandprint. Not a 104-commit rebase, not a rebuild.

## Architecture overview

Three layers, two of which already exist:

```
Capture            Deliver (exists)              Apply
--------           ----------------              -----
intake ->  Brandprint pointer (collection)  ->  default: agent reads derive://brandprint/*
                                                          before authoring (auto)
                                                Rework: ⋯ menu -> ask-agent inbox ->
                                                          agent revises -> new version
```

- **Capture** is new: turn a short intake into a Brandprint convention artifact and point the workspace or user at it. Pure storage, no model.
- **Deliver** is Anir's Phase A: resolve workspace ⊕ profile, expose each convention doc as an MCP resource, and add a one-line instructions pointer. Ported and renamed.
- **Apply, default path** is Anir's Phase A: the agent reads those resources on its own before it writes.
- **Apply, on demand** is new but reuses the existing ask-agent inbox: the Rework button hands the whole artifact to the connected agent with a canned "match our Brandprint" instruction.

## Data model

No schema change. Reuse Anir's storage exactly, renamed.

- **Workspace Brandprint:** `OrgSettings.brandprint`, a JSON blob `{ collectionId?, theme? }`. Stored in the existing org settings JSON.
- **Personal Brandprint:** a Better Auth additional field `brandprint` (JSON string) on the user, alongside `profession` and `about`. `MetaStore.getUserBrandprint` / `setUserProfile` handle read and write, defensively (an old or minimal user row returns null).
- **Types:**
  - `Brandprint = { collectionId?: string; theme?: BrandprintTheme }`
  - `BrandprintTheme = { palette?: Record<string,string>; fonts?: Record<string,string>; dark?: { palette?: Record<string,string> } }` (captured, not yet applied)
- **Resolution:** `resolveBrandprint(ws, profile)` returns `{ collectionIds: string[], theme? }`, workspace first then profile appended and deduped, theme merged with profile winning per key. Pure and unit-tested.

A Brandprint points at a **collection** of convention artifacts (Anir's model), so a team can grow from one seeded doc to several without a data change. The seed flow (below) creates the first one.

## Capture: the intake

New. Turns pasted text into a Brandprint the delivery layer can already read.

Flow:

1. The user pastes brand guidelines, a link, or a sample document into a single textarea, at workspace or personal scope.
2. Derive creates a normal markdown artifact from that text (title defaults to "Brandprint"), ensures a collection named "Brandprint" exists for that scope, adds the artifact to it, and sets `brandprint.collectionId` to that collection. All storage, no model.
3. The artifact is a first-class Derive artifact from then on: editable in the normal editor, visible in the library, versioned.

Endpoint (added to the contract-first API spec so the web client regenerates, per #331):

```
POST /v1/brandprint/seed
body: { scope: "workspace" | "personal", text: string, title?: string }
-> { collectionId, shortId }
```

The endpoint is inference-free. It composes the artifact and collection, sets the pointer for the given scope, and returns the created artifact so the client can offer "edit it" or "expand it" next.

**Agent enrichment (future phase).** Later, when an agent is connected, a surface can offer "Have your agent expand this into a fuller style guide," which is a Rework handoff (below) pointed at the Brandprint convention artifact itself. This is deferred to a future phase. For v1, raw pasted notes are a valid, useful Brandprint on their own, and the convention doc is editable in the normal artifact editor.

## Deliver: MCP (ported from Phase A)

Unchanged from Anir's work except the rename. In `apps/api/src/mcp.ts`, `buildServer` becomes async and, per actor:

1. Resolves `brandprint` for the workspace, merged with the owner's personal `brandprint`.
2. Pulls every artifact in the resolved collection(s).
3. Registers each as a readable resource `derive://brandprint/<short_id>` (`audience: ["assistant"]`, `priority: 0.9`, body fetched lazily as the current version's text).
4. Appends a one-line pointer to the server `instructions`: "This workspace has a Brandprint: N convention docs on how to build things here. Read the `derive://brandprint/*` resources before authoring; your personal Brandprint takes precedence."

This is the default, automatic path. A connected agent reads the Brandprint on its own before it creates or revises, no user action required.

## Apply on demand: the Rework button

New surface, existing plumbing. Rework is a canned version of the ask-agent handoff, scoped to the whole artifact.

### Where it lives

The artifact overflow (⋯) menu in `apps/web/src/pages/artifact/artifact-top-bar.tsx`, as a new item "Rework with Brandprint." The menu is props-driven; Rework is added as a self-contained menu-item component so the top bar stays lean and the three-state logic lives in one place.

### What it does

1. Resolves the workspace's registered agents (same source the existing `AskAgentButton` uses).
2. **One agent:** fires immediately. **Several agents:** opens a small picker (mirrors `AskAgentButton`). **No agent:** routes to the shared Connect-an-agent surface (below) instead of firing.
3. Firing posts an artifact-scoped request that @mentions the chosen agent with a canned instruction, which drops into that agent's MCP pull inbox. The agent reads the request, reads its `derive://brandprint/*` resources, revises the whole document, and publishes.

Canned instruction (kept server-side as the single source of truth):

```
Rework this artifact to match our Brandprint. Read the derive://brandprint/*
resources first, then revise the whole document so its voice, structure, and
formatting match. Preserve the meaning and the facts; change how it reads,
not what it says. Publish the result as a new version.
```

Endpoint (thin wrapper over the existing @mention-to-inbox path, so the canned prompt is not duplicated in the client):

```
POST /v1/artifacts/:shortId/rework
body: { agentId?: string }   // omit to use the sole registered agent
-> { requestId }             // 409 needsAgent when the workspace has none
```

### Output

The agent produces a **new version**, following its grant: a publish-capable agent posts it directly; a lower-grant agent files it as a proposal for approval. This is exactly how Derive gates every other agent write, so there is no special case. Because Rework always creates a new version rather than overwriting, the original is preserved in history and the change is fully reversible.

A future "Always review Reworks" workspace setting could force the proposal path even for publish-capable agents. Out of scope for v1; the grant default covers it.

## No agent connected: one shared surface

New, built once, reused three times: the Rework menu item, the Brandprint save state, and onboarding. All three lead to the same place when no agent is registered.

A `<ConnectAgent>` surface (dialog or panel) reuses the content that already lives in `welcome.tsx` Step 2: the paste-into-your-agent prompt for hosted, with the self-host toggle. Extracting that block from `welcome.tsx` into a shared component is part of this work, so onboarding and these two new entry points render the same thing.

The honest framing shown to the user: Brandprint is captured and saved immediately, but it has nobody to *apply* it until an agent is connected. Both the default path and Rework depend on a connected agent, so the connect prompt appears wherever Brandprint would otherwise act.

## Onboarding

New step in `apps/web/src/pages/welcome.tsx`, after Step 2 (Connect an agent), fully skippable in the same way the profile fields and passkey nudge already are. Skipping leaves Brandprint for Settings and sets nothing.

**Who sees it.** The step is shown only to the person setting up a workspace's Brandprint for the first time: the user is an owner or admin of their active workspace and that workspace has no Brandprint yet. It creates the **workspace** Brandprint (`scope: "workspace"`), so everyone who later joins that team inherits it. Someone joining a workspace that already has a Brandprint does not see the step at all; they inherit the team's Brandprint automatically over MCP, with nothing to set up. Detection uses the active workspace's settings (whether `brandprint` is set) and the user's role in it, both already available to the client.

**Timing.** Derive creates team workspaces at first need, often after onboarding. So the same one-time, dismissible prompt also appears the first time an owner lands in a Brandprint-less team workspace, so the "first on the team" moment is caught wherever it actually happens, not only at signup.

The step leads with a plain-language explanation so there is no confusion about what Brandprint is:

- Eyebrow: "Step 3 · Your team's Brandprint (optional)"
- Explainer: "A Brandprint is your team's style in one place: your tone of voice, formatting rules, words to use or avoid, and colors. Every agent that works in Derive reads it automatically before it creates or revises anything, so the work matches your brand from the first draft, with no one re-explaining it each time. Set it once here and everyone who joins your team inherits it."
- Intake: a single textarea. "Paste your brand guidelines, a link, or a sample doc that already sounds right. We'll save it as your team's Brandprint; you can refine it anytime."
- Primary action saves via `POST /v1/brandprint/seed` at workspace scope.
- If no agent is connected at this point: a quiet line, "Your Brandprint saves now and starts applying the moment an agent is connected," with the shared Connect surface one tap away.
- Secondary action: "Skip for now."

## Settings

Port Anir's `settings/house-style-section.tsx` to `settings/brandprint-section.tsx` on both the workspace and account sections, and add the intake there too, so Brandprint can be created or changed after onboarding:

- The existing collection picker (point Brandprint at an existing collection) stays for teams that already keep convention docs.
- The new intake (paste to seed) sits above it as the default, no-brainer path.
- Enrichment ("expand my notes into a fuller style guide") is deferred to a future phase; see Phasing.

## API surface summary

Ported and renamed (from Phase A):

- `PATCH /v1/workspace/settings` accepts `brandprint: { collectionId?, theme? } | null` (deep merge one level, null clears).
- `POST /v1/me/profile` accepts `brandprint: { ... } | null` alongside `profession` and `about`.

New:

- `POST /v1/brandprint/seed`: create a convention artifact from pasted text, wire the collection and pointer, inference-free.
- `POST /v1/artifacts/:shortId/rework`: compose and post the canned @mention request to a chosen or sole registered agent; `409 needsAgent` when none.

All new endpoints are defined in the contract-first Zod spec (#331), so the web client is regenerated rather than hand-written.

## Web surfaces summary

- `pages/artifact/artifact-top-bar.tsx`: new "Rework with Brandprint" ⋯ item (self-contained three-state component).
- `components/shared/connect-agent.tsx` (new): shared Connect surface extracted from `welcome.tsx` Step 2.
- `pages/welcome.tsx`: new skippable Step 3 with the Brandprint explainer and intake.
- `pages/settings/brandprint-section.tsx` (ported + renamed): collection picker plus intake (enrichment deferred to a later phase).

## Port plan (foundation)

Bring Anir's Phase A onto current main without a 104-commit rebase. Main has since reworked `mcp.ts` (#328) and made the API contract-first (#331), which are the files most likely to conflict.

1. **Cherry-pick the pure, low-conflict parts:** `packages/core/src/brandprint.ts` (renamed from `house-style.ts`) and its unit tests, the `Brandprint` / `BrandprintTheme` types in `ports.ts`, and the DB adapter methods in `packages/db/src/{sqlite,pg,d1}.ts` plus their store tests.
2. **Re-apply the wiring by hand against current main:** the `mcp.ts` resource registration and instructions pointer (on top of #328's version), the `workspace.ts` and `session.ts` route additions (as contract-first Zod routes, per #331), and the Settings section (renamed).
3. **Rename everywhere** per the table above as part of the port, so nothing lands as "house-style."
4. Land this as its own PR (Phase 0) before building the new surfaces, so the foundation is green and reviewed on its own.

## Testing

- **Core:** `resolveBrandprint`, `parseBrandprint`, `brandprintInstructions` unit tests (ported and renamed).
- **API:** `brandprint/seed` creates the artifact, collection, and pointer at each scope with no model; workspace and profile patches merge and clear correctly; `artifacts/:id/rework` composes the correct @mention and lands it in the agent inbox, and returns `needsAgent` when the workspace has none.
- **MCP:** a seeded collection registers `derive://brandprint/*` resources and appends the pointer (ported from Anir's MCP test).
- **Web:** onboarding Step 3 renders, saves, and skips; the Rework menu item shows the correct one of fire / picker / connect for zero, one, and several agents; the Settings section seeds and edits.

## Phasing

- **Phase 0 (foundation):** port Anir's Phase A forward, renamed to Brandprint. One PR, green on its own.
- **Phase 1 (capture):** the seed endpoint, the shared Connect-an-agent surface, the Settings intake, and the onboarding step.
- **Phase 2 (apply):** the Rework ⋯ item, the rework endpoint, and the no-agent routing.
- **Phase 3 (later, optional):** agent enrichment of the Brandprint doc, visual theme application (Anir's Phase B), and an "Always review Reworks" setting.

## Decisions log

Resolved during review, now reflected in the body above:

1. **Collection, not single doc.** Brandprint points at a collection so a team can grow from one seeded doc to several with no migration.
2. **Onboarding is workspace-scoped and conditional.** The first person to set up a workspace's Brandprint sees the step and it creates the workspace Brandprint. Anyone joining a workspace that already has one never sees the step and inherits it automatically.
3. **Enrichment is deferred.** "Expand my notes into a fuller style guide" waits for a later phase (Phase 3). v1 stores raw pasted notes, which are a valid Brandprint on their own.
