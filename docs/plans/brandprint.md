# Brandprint

Status: living spec. Phase 0 and the capture surface have shipped; the unshipped rows in the Status table below are the active roadmap.
Owner: Connor
Related prior art: `feat/house-style` (Anir, unmerged; ported forward as Phase 0)

## One line

Every team gets a **Brandprint**: their voice, style, and rules captured once, read automatically by any agent that works in Derive, and applied on demand to existing artifacts with a one-click **Rework** button.

## Status

| Piece | State |
| --- | --- |
| Phase 0: port + MCP delivery | Shipped (#378) |
| Phase 1: capture (create dialog: upload look/read files, write notes, pick a collection) | Shipped (#383) |
| Phase 1: Brandprint as a top-level page in the rail | Shipped (#384) |
| Phase 1: shared Connect-an-agent surface | Built, in review (`feat/brandprint-connect`) |
| Phase 1: onboarding step + owner home nudge | Built, in review (`feat/brandprint-connect`) |
| Phase 2: Rework button + endpoint + no-agent routing | **Next up** |
| Phase 3: enrichment, visual theme application, "Always review Reworks" | Later |

Sections below marked **(shipped)** describe behavior now on main. Everything else is still spec, and it is what we build next.

## Why this exists

AI produces more work than a team can re-brief. Today, matching that output to a company's voice means re-explaining the brand in every prompt, or fixing tone and style by hand after the fact. Derive already keeps the work; Brandprint keeps the *taste*, so the work comes out on-brand from the first draft without anyone remembering to ask.

Two facts shape the whole design:

1. **Derive runs no inference of its own.** All model work is done by the user's connected agent (Claude Code, Codex, and so on) over MCP. Anything that needs a model has to route to that agent. Anything that is just storage can happen server-side with no model.
2. **Half of this already existed.** Anir's `feat/house-style` branch built the delivery layer (conventions resolved per workspace and per user, handed to agents over MCP). And Derive already has an "ask an agent" mechanism that hands a scoped change to a connected agent's pull inbox and gets back a reviewable revision. Brandprint is largely a composition of these two systems, not new plumbing.

## Naming

The user-facing name is **Brandprint**. Anir's branch called it "House Style" in both copy and code; the Phase 0 port renamed every identifier so the product name and the codebase never drift.

| `house-style` (Anir's branch) | `brandprint` (shipped) |
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
| web `settings/house-style-section.tsx` | `pages/brandprint/brandprint-section.tsx` (ported into Settings in #378, promoted to its own page in #384) |
| tests `*house-style*` | `*brandprint*` |

## Goals

- A team can capture its Brandprint in under a minute, with no pre-existing documents and no agent connected.
- Any connected agent reads the Brandprint automatically before it creates or revises anything.
- A person can point at an existing artifact and get an on-brand version back in one click, then review it.
- Skipping any of this never dead-ends the user. It degrades to a clear "connect an agent" prompt.
- Non-technical users are first-class. Nothing here requires writing convention docs by hand or editing config.

## Non-goals

- Visual theme application (rendering artifacts with the Brandprint's palette and fonts). Anir captured theme tokens in the data model; applying them is his Phase B and stays out of scope here. The capture surface deliberately collects "look" docs now so that phase has its extraction source ready.
- Derive performing any inference itself. If a step needs a model, it routes to the connected agent.
- A live chat assistant inside Derive. The agent interaction is the existing asynchronous "hand off a task, get back a revision" shape, not a conversation.

## Architecture overview

Three layers; capture and delivery have shipped, on-demand apply is next.

```
Capture (shipped)         Deliver (shipped)             Apply
-----------------         -----------------             -----
create dialog ->  Brandprint pointer (collection)  ->  default (shipped): agent reads
(upload look/read,                                       derive://brandprint/* before
 write, or pick)                                          authoring (auto)
                                                       Rework (next): ⋯ menu -> ask-agent
                                                          inbox -> agent revises -> new version
```

- **Capture** turns files or pasted notes into a Brandprint convention collection and points the workspace or user at it. Pure storage, no model.
- **Deliver** is Anir's Phase A, ported: resolve workspace ⊕ profile, expose each convention doc as an MCP resource, and add a one-line instructions pointer.
- **Apply, default path** is Anir's Phase A: the agent reads those resources on its own before it writes.
- **Apply, on demand** reuses the existing ask-agent inbox: the Rework button hands the whole artifact to the connected agent with a canned "match our Brandprint" instruction.

## Data model (shipped)

No schema change. Anir's storage exactly, renamed.

- **Workspace Brandprint:** `OrgSettings.brandprint`, a JSON blob `{ collectionId?, theme? }`. Stored in the existing org settings JSON.
- **Personal Brandprint:** a Better Auth additional field `brandprint` (JSON string) on the user, alongside `profession` and `about`. `MetaStore.getUserBrandprint` / `setUserProfile` handle read and write, defensively (an old or minimal user row returns null).
- **Types:**
  - `Brandprint = { collectionId?: string; theme?: BrandprintTheme }`
  - `BrandprintTheme = { palette?: Record<string,string>; fonts?: Record<string,string>; dark?: { palette?: Record<string,string> } }` (captured, not yet applied)
- **Resolution:** `resolveBrandprint(ws, profile)` returns `{ collectionIds: string[], theme? }`, workspace first then profile appended and deduped, theme merged with profile winning per key. Pure and unit-tested.
- **Tenancy:** both write paths validate the `collectionId` server-side. A workspace pointer must name a collection in that workspace; a personal pointer must name a collection in a workspace the user belongs to. An unvalidated id could point a Brandprint at another tenant's collection and have MCP serve its contents (closed in #378's review).

A Brandprint points at a **collection** of convention artifacts, so a team can grow from one doc to several without a data change.

## The Brandprint page (shipped, #384)

Brandprint is a top-level destination: `/brandprint`, in the rail directly under Contexts (Fingerprint mark). The page shows both halves in one place: **Workspace Brandprint** (Admin-gated writes) and **Your Brandprint** (personal, layered over the workspace's, yours wins). It replaced the original placement embedded in Settings → General and Settings → Profile, which split the feature across two screens.

The page is also the docs' one home. The pointed collection is hidden from the general collection surfaces (rail, command palette, the organize dialogs), and the page carries a managed **Documents** list: open each doc, remove it from the Brandprint (the artifact lives on in the library), add more via upload. Hiding is client-side with no API change: your own pointers ride the session and the member-readable workspace settings, and a teammate's personal Brandprint collection is invite-only, so it never listed for you in the first place.

## Capture: the create dialog (shipped, #383)

An empty scope shows one **Create Brandprint** button. Its dialog offers three ways in:

1. **Upload files** (default), split into the two halves of a brand:
   - *How your artifacts should look*: brand and style guides, palettes, font specs, CSS tokens, or example HTML that carries the look.
   - *How your artifacts should read*: voice and tone, grammar, warmth, structure, wording do's and don'ts.
   Picks stage into one labeled batch (Look/Read pills, removable) and a single action creates everything. Either category alone works; the split is UX framing today and becomes the extraction source for Phase 3 theme work. Accepted types: `.md`, `.markdown`, `.txt`, `.html`, `.htm`, `.css`.
2. **Write it**: type or paste conventions into a textarea (optional title); they publish as a normal, editable markdown doc.
3. **Use a collection**: the picker, for teams that already keep convention docs together.

Once set, the section shows the pointer plus an "Upload documents" row that publishes more docs straight into the collection. Clearing the pointer returns to the create state.

**Mechanics.** Shipped as client-side composition of existing endpoints inside one governed mutation, with no new API: create the collection when the Brandprint is empty, publish each file, add it to the collection, open the collection to the workspace (workspace scope, so teammates can read the docs; collection access propagates to contents), then set the pointer. Per-file failures don't abort the batch; the pointer is only set once at least one doc lands; a total failure deletes the empty collection so retries start clean. Titles derive server-side from each doc's heading or filename.

**Deviations from the original plan** (see Decisions log):

- `POST /v1/brandprint/seed` was **not built**. The client-side composition covered the whole in-app surface. Revisit only if the onboarding step wants a single atomic round-trip.
- A URL intake (fetch a page as the seed) did not ship; paste and files cover v1.

## Deliver: MCP (shipped, #378)

In `apps/api/src/mcp.ts`, `buildServer` is async and, per actor:

1. Resolves `brandprint` for the workspace, merged with the owner's personal `brandprint`.
2. Pulls every artifact in the resolved collection(s).
3. Registers each as a readable resource `derive://brandprint/<short_id>` (`audience: ["assistant"]`, `priority: 0.9`, body fetched lazily as the current version's text).
4. Appends a one-line pointer to the server `instructions`: "This workspace has a Brandprint: N convention docs on how to build things here. Read the `derive://brandprint/*` resources before authoring; your personal Brandprint takes precedence."

This is the default, automatic path. A connected agent reads the Brandprint on its own before it creates or revises, no user action required.

---

Everything below this line is **not yet built**. It is the roadmap, in build order.

## Apply on demand: the Rework button (next, Phase 2)

New surface, existing plumbing. Rework is a canned version of the ask-agent handoff, scoped to the whole artifact.

### Where it lives

The artifact overflow (⋯) menu in `apps/web/src/pages/artifact/artifact-top-bar.tsx`, as a new item "Rework with Brandprint." The menu is props-driven; Rework is added as a self-contained menu-item component so the top bar stays lean and the state logic lives in one place.

### What it does

The item resolves two things: whether a Brandprint exists, then which agents are registered.

1. **No Brandprint resolved** (neither workspace nor personal): the item renders as "Set up your Brandprint" and routes to `/brandprint` instead of firing. Firing the canned instruction with zero `derive://brandprint/*` resources behind it would hand the agent an empty brief. Detection is client-side from the same sources the Brandprint page reads (workspace settings + `me.brandprint`).
2. **Brandprint set, no agent registered:** routes to the shared Connect-an-agent surface (below) instead of firing.
3. **One agent:** fires immediately. **Several agents:** opens a small picker (mirrors `AskAgentButton`).
4. Firing posts an artifact-scoped request that @mentions the chosen agent with a canned instruction, which drops into that agent's MCP pull inbox. The agent reads the request, reads its `derive://brandprint/*` resources, revises the whole document, and publishes.

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

## No agent connected: one shared surface (next, Phase 1 remainder)

New, built once, reused three times: the Rework menu item, the Brandprint page's saved-but-inert state, and onboarding. All three lead to the same place when no agent is registered.

A `<ConnectAgent>` surface (dialog or panel) reuses the content that already lives in `welcome.tsx` Step 2: the paste-into-your-agent prompt for hosted, with the self-host toggle. Extracting that block from `welcome.tsx` into a shared component is part of this work, so onboarding and these two new entry points render the same thing. (This also fixes a known IA gap: the library's "Connect an agent" empty-state button currently lands on Settings → Agents, the workspace-bot token form, not the MCP connect prompt. Point it here.)

The honest framing shown to the user: Brandprint is captured and saved immediately, but it has nobody to *apply* it until an agent is connected. Both the default path and Rework depend on a connected agent, so the connect prompt appears wherever Brandprint would otherwise act.

## Onboarding (next, Phase 1 remainder)

New step in `apps/web/src/pages/welcome.tsx`, after Step 2 (Connect an agent), fully skippable in the same way the profile fields and passkey nudge already are. Skipping leaves Brandprint for the `/brandprint` page and sets nothing.

**Who sees it.** The step is shown only to the person setting up a workspace's Brandprint for the first time: the user is an owner or admin of their active workspace and that workspace has no Brandprint yet. It creates the **workspace** Brandprint (`scope: "workspace"`), so everyone who later joins that team inherits it. Someone joining a workspace that already has a Brandprint does not see the step at all; they inherit the team's Brandprint automatically over MCP, with nothing to set up. Detection uses the active workspace's settings (whether `brandprint` is set) and the user's role in it, both already available to the client.

**Timing.** Derive creates team workspaces at first need, often after onboarding. So the same one-time, dismissible prompt also appears the first time an owner lands in a Brandprint-less team workspace, so the "first on the team" moment is caught wherever it actually happens, not only at signup.

The step leads with a plain-language explanation so there is no confusion about what Brandprint is:

- Eyebrow: "Step 3 · Your team's Brandprint (optional)"
- Explainer: "A Brandprint is your team's style in one place: your tone of voice, formatting rules, words to use or avoid, and colors. Every agent that works in Derive reads it automatically before it creates or revises anything, so the work matches your brand from the first draft, with no one re-explaining it each time. Set it once here and everyone who joins your team inherits it."
- Intake: reuse the shipped create-dialog intake (the write tab's textarea at minimum; the look/read upload if it fits the step). Same composition, workspace scope.
- If no agent is connected at this point: a quiet line, "Your Brandprint saves now and starts applying the moment an agent is connected," with the shared Connect surface one tap away.
- Secondary action: "Skip for now."

If this step wants a single atomic call instead of the client-side composition, that is the one reason to revive `POST /v1/brandprint/seed` (Decisions log #6).

## API surface summary

Shipped (#378):

- `PATCH /v1/workspace/settings` accepts `brandprint: { collectionId?, theme? } | null` (deep merge one level, null clears; collection ownership validated).
- `POST /v1/me/profile` accepts `brandprint: { ... } | null` alongside `profession` and `about` (membership validated).

Not built, still specced:

- `POST /v1/artifacts/:shortId/rework` (Phase 2): compose and post the canned @mention request to a chosen or sole registered agent; `409 needsAgent` when none.
- `POST /v1/brandprint/seed`: superseded by the shipped client-side composition; revive only for onboarding atomicity (Decisions log #6).

Any new endpoint is defined in the contract-first Zod spec (#331), so the web client is regenerated rather than hand-written.

## Web surfaces summary

Shipped:

- `pages/brandprint/` (#383, #384): the `/brandprint` page composing both scopes; the section with the create dialog (upload look/read, write, pick) and the add-docs row; rail item `nav-brandprint` under Contexts.

Next:

- `components/shared/connect-agent.tsx`: shared Connect surface extracted from `welcome.tsx` Step 2 (Phase 1 remainder).
- `pages/welcome.tsx`: skippable Step 3 with the Brandprint explainer and intake (Phase 1 remainder).
- `pages/artifact/artifact-top-bar.tsx`: "Rework with Brandprint" ⋯ item, four-state per the gate above (Phase 2).

## Testing

Shipped coverage (#378, #383):

- **Core:** `resolveBrandprint`, `parseBrandprint`, `brandprintInstructions` unit tests.
- **API:** workspace and profile patches merge and clear correctly; foreign and unknown `collectionId` rejected on both write paths; storage round-trips across sqlite/pg/d1.
- **MCP:** an end-to-end test seeds a collection, points the workspace at it, and asserts the `derive://brandprint/*` resources and instructions pointer.
- **Web:** none yet; the create dialog and page carry testids (`brandprint-create-*`, `brandprint-upload-look/read-*`, `brandprint-notes-*`, `brandprint-pick-collection-*`, `nav-brandprint`) for an e2e follow-up.

To write with the remaining phases:

- **API:** `artifacts/:id/rework` composes the correct @mention, lands it in the agent inbox, and returns `needsAgent` when the workspace has none.
- **Web:** onboarding Step 3 renders, saves, and skips; the Rework item shows the correct one of set-up / connect / fire / picker for its four states; an e2e over the create dialog.

## Phasing

- **Phase 0 (foundation): shipped** (#378). Anir's Phase A ported forward, renamed, with the cross-tenant ownership validation added in review.
- **Phase 1 (capture): complete pending review.** The intake shipped as the create dialog on the `/brandprint` page (#383, #384), client-side, no seed endpoint. The shared ConnectAgent surface, the onboarding Step 3 (seeding through the same intake — the seed endpoint stayed unnecessary), the owner home nudge, and the /brandprint saved-but-inert nudge (keyed off connected OAuth agents) are on `feat/brandprint-connect`.
- **Phase 2 (apply): next up.** The Rework ⋯ item (gated on a Brandprint existing), the rework endpoint, and the no-agent routing.
- **Phase 3 (later, optional):** agent enrichment of the Brandprint doc, visual theme application (Anir's Phase B, fed by the "look" docs), and an "Always review Reworks" setting.

## Decisions log

Resolved during review and build, reflected in the body above:

1. **Collection, not single doc.** Brandprint points at a collection so a team can grow from one seeded doc to several with no migration.
2. **Onboarding is workspace-scoped and conditional.** The first person to set up a workspace's Brandprint sees the step and it creates the workspace Brandprint. Anyone joining a workspace that already has one never sees the step and inherits it automatically.
3. **Enrichment is deferred.** "Expand my notes into a fuller style guide" waits for a later phase (Phase 3). v1 stores raw pasted notes, which are a valid Brandprint on their own.
4. **Brandprint is a top-level destination** (#384). Promoted out of Settings to `/brandprint` in the rail, a peer of Contexts, so the workspace and personal halves read as one feature.
5. **Capture asks for both halves of the brand** (#383). The upload intake splits into "how your artifacts should look" and "how your artifacts should read." Either alone works; both are first-class, and the look docs are the planned extraction source for Phase 3 theming.
6. **No seed endpoint** (#383). The intake shipped as client-side composition of existing endpoints inside one governed mutation. `POST /v1/brandprint/seed` is revived only if the onboarding step wants a single atomic round-trip.
7. **Rework gates on a Brandprint existing.** With none resolved, the ⋯ item reads "Set up your Brandprint" and routes to `/brandprint`; the canned instruction never fires against zero convention docs.
8. **The Brandprint collection is not a Collection, to users.** It stays a collection in the data model (the delivery layer reads it unchanged), but it never surfaces in the rail, palette, or organize dialogs; its docs are managed on `/brandprint` only, so the files and the options have one home.
