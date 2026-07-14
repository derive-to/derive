# Brandprint

Status: living spec. Phases 0–2 have shipped end to end (#392 merged the brand profile). Phase 3, Rework, is built (this PR); Phase 4 remains directional.
Owner: Connor
Related prior art: `feat/house-style` (Anir, unmerged; ported forward as Phase 0)

## One line

Every team gets a **Brandprint**: their voice, style, and rules captured once, distilled by their own agent into one beautiful, machine-readable **brand profile**, read automatically by any agent that works in Derive, and applied on demand to existing artifacts with a one-click **Rework** button.

## Status

| Piece | State |
| --- | --- |
| Phase 0: port + MCP delivery | Shipped (#378) |
| Phase 1: capture (create dialog: upload look/read files, write notes, pick a collection) | Shipped (#383) |
| Phase 1: Brandprint as a top-level page in the rail | Shipped (#384) |
| Phase 1: docs managed on `/brandprint` only (collection hidden from Collections) + team-scope dialog copy | Shipped (#386) |
| Phase 1: shared Connect-an-agent surface | Shipped (#388) |
| Phase 1: onboarding step + owner home nudge | Shipped (#388) |
| Phase 2: the brand profile (agent-generated, tasteprofile take) | Shipped (#392) |
| Phase 3: Rework button + endpoint + no-agent routing | Built (this PR) |
| Phase 4: enrichment, visual theming from profile tokens, "Always review Reworks" | Later |

Sections below marked **(shipped)** describe behavior now on main; the Rework section (Phase 3) is built on this PR and lands when it merges. Only Phase 4 is still spec.

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

- Visual theme application (rendering artifacts with the Brandprint's palette and fonts). Out of scope until Phase 4, and its token source is now the brand profile's embedded tokens rather than the (removed) `BrandprintTheme` blob. The capture surface deliberately collects "look" docs so profile generation has its extraction source ready.
- Derive performing any inference itself. If a step needs a model, it routes to the connected agent.
- A live chat assistant inside Derive. The agent interaction is the existing asynchronous "hand off a task, get back a revision" shape, not a conversation.

## Architecture overview

Three layers; capture, delivery, and the generated profile (Phase 2, #392) have shipped; on-demand apply (Phase 3, Rework) is built on this PR.

```
Capture (shipped)         Deliver (shipped)             Apply (built)
-----------------         -----------------             -------------
create dialog ->  Brandprint pointer (collection)  ->  default (shipped): agent reads
(upload look/read,   + brand profile (Phase 2):          derive://brandprint/* before
 write, or pick)     their agent reads sources +         authoring (auto)
                     reference, proposes one HTML     Rework (Phase 3): ⋯ menu -> ask-agent
                     profile, human approves             inbox -> agent revises -> new version
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
  - `BrandprintTheme = { palette?: Record<string,string>; fonts?: Record<string,string>; dark?: { palette?: Record<string,string> } }` (captured, never applied; Phase 2 removes it, superseded by the profile's embedded tokens)
- **Resolution:** `resolveBrandprint(ws, profile)` returns `{ collectionIds: string[], theme? }`, workspace first then profile appended and deduped, theme merged with profile winning per key. Pure and unit-tested.
- **Tenancy:** both write paths validate the `collectionId` server-side. A workspace pointer must name a collection in that workspace; a personal pointer must name a collection in a workspace the user belongs to. An unvalidated id could point a Brandprint at another tenant's collection and have MCP serve its contents (closed in #378's review).

A Brandprint points at a **collection** of convention artifacts, so a team can grow from one doc to several without a data change.

## The Brandprint page (shipped, #384)

Brandprint is a top-level destination: `/brandprint`, in the rail directly under Contexts (Fingerprint mark). The page shows both halves in one place: **Workspace Brandprint** (Admin-gated writes) and **Your Brandprint** (personal, layered over the workspace's, yours wins). It replaced the original placement embedded in Settings → General and Settings → Profile, which split the feature across two screens.

The page is also the docs' one home (#386). The pointed collection is hidden from the general collection surfaces (rail, command palette, the organize dialogs), and the page carries a managed **Documents** list: open each doc, remove it from the Brandprint (the artifact lives on in the library), add more via upload. Hiding is client-side with no API change: your own pointers ride the session and the member-readable workspace settings, and a teammate's personal Brandprint collection is invite-only, so it never listed for you in the first place.

## Capture: the create dialog (shipped, #383)

An empty scope shows one **Create Brandprint** button. Its dialog offers three ways in:

1. **Upload files** (default), split into the two halves of a brand:
   - *How your artifacts should look*: brand and style guides, palettes, font specs, CSS tokens, or example HTML that carries the look.
   - *How your artifacts should read*: voice and tone, grammar, warmth, structure, wording do's and don'ts.
   Picks stage into one labeled batch (Look/Read pills, removable) and a single action creates everything. Either category alone works; the split is UX framing today and becomes extraction guidance for the Phase 2 brand profile. Accepted types: `.md`, `.markdown`, `.txt`, `.html`, `.htm`, `.css`. At workspace scope the headings read "How your **team's** artifacts should look/read" (#386); personal scope keeps "your artifacts". The category value itself is the heading's final verb, so the copy and the category can't drift apart.
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

## No agent connected: one shared surface (shipped, #388)

Built once, reused everywhere the feature would otherwise dead-end. `components/shared/connect-agent.tsx` holds the paste-into-your-agent block extracted from `welcome.tsx` Step 2 (hosted prompt, self-host toggle, copy button), plus a one-line `ConnectAgentButton` that opens it in a dialog from anywhere. Welcome's e2e testids were preserved via a prefix parameter.

Four entry points render the same surface: onboarding Step 2, the library's "Connect an agent" empty state (which previously dead-ended on the workspace-bot token form in Settings → Agents, the known IA gap, now fixed), the owner home nudge (below), and the `/brandprint` saved-but-inert band. The profile hand-off card (Phase 2) and the Rework menu item (Phase 3) became the fifth and sixth.

The honest framing shown to the user: Brandprint is captured and saved immediately, but it has nobody to *apply* it until an agent is connected. When a Brandprint exists but the caller has never authorized an MCP agent, the `/brandprint` page says so plainly, with the Connect surface one tap away. The signal is the OAuth connected-agents list, a query now shared with Security's revocation section rather than duplicated there.

## Onboarding (shipped, #388)

Step 3 in `apps/web/src/pages/welcome.tsx`, after Step 2 (Connect an agent), fully skippable in the same way the profile fields and passkey nudge already are. Skipping leaves Brandprint for the `/brandprint` page and sets nothing.

**Who sees it.** Only the person setting up a workspace's Brandprint for the first time: the user is an owner or admin of their active workspace and that workspace has no Brandprint yet (which includes every fresh signup, by design). It creates the **workspace** Brandprint, so everyone who later joins that team inherits it. Someone joining a workspace that already has a Brandprint never sees the step; they inherit the team's Brandprint automatically over MCP. Detection is client-side from the active workspace's settings and the user's role in it.

**Timing.** Derive creates team workspaces at first need, often after onboarding. So a one-time, dismissible nudge on the home library ("Set up your team's Brandprint") catches owners whose Brandprint-less workspace was created after onboarding, so the "first on the team" moment is caught wherever it actually happens, not only at signup.

**What shipped.** The step leads with the plain-language explainer (eyebrow: "Step 3 · Your team's Brandprint (optional)") and one optional textarea, the lightest useful capture. Pasted notes seed the workspace Brandprint through the exact same intake as the create dialog, extracted into a shared `useBrandprintImport` hook rather than duplicated. It rides the page's single Continue action per welcome's no-per-section-save philosophy; seeding runs *before* the profile writes, so a failure keeps the user on the page with their notes intact and a specific inline error, and retries can't double-seed because the settings cache flips the step off after success. That failure/retry design settled the open spec question: `POST /v1/brandprint/seed` stays unnecessary (Decisions log #6). If no agent is connected, the quiet "saves now, applies when an agent connects" line points at the shared Connect surface.

---

Below this line are the later phases: the brand profile, shipped (#392); Rework (Phase 3), built on this PR; and Phase 4, still directional roadmap.

## The brand profile (shipped, #392)

Our take on tasteprofile.io ("Brand guides are PDFs. AI tools need data."): every Brandprint culminates in one generated, beautiful, machine-readable HTML page, the **brand profile**, assembled by the user's own agent. Derive ships reference material and plumbing only; it never runs inference and never owns an agent.

### The flow

1. **Feed it.** The workspace-scope create dialog keeps its intake (upload look/read files, write notes, pick a collection) and its one-action save. Uploads are now framed as *source material*.
2. **Hand it off.** Completing the intake also creates one placeholder artifact, **"Brand profile"**, in the Brandprint collection, stores its id in the pointer, and flips the dialog's final step to a hand-off card: a three-line copyable brief plus the shared ConnectAgent surface one tap away. The brief tells the agent to connect to Derive, read `derive://brandprint/reference` and the source docs, build the profile, and file it with `for_review: true` against the placeholder's short_id.
3. **The agent builds.** It reads the reference resources and sources, authors a single self-contained HTML page, and files it as a proposal on the placeholder. All heavy instruction lives in the reference resources, not the pasted brief, so the reference improves without users re-copying anything.
4. **The reveal.** `/brandprint` flips from "your agent is building your brand profile" to a full-bleed preview with Approve and inline comments. Comments round-trip through the existing feedback loop, so "make the yellow warmer" goes back to their agent like any other Derive revision. The first thing a new team does in Derive becomes a live demo of the publish → review → revise loop, on their own brand.
5. **Approve.** The proposal goes live via the existing approval route. The profile is now what agents read first.

Until step 5, the raw sources serve as the Brandprint exactly as shipped today, so a user with no agent (or one who wanders off mid-flow) degrades gracefully, never dead-ends.

### Recognition mechanics: the placeholder is the contract

Proposals can only revise an existing artifact (creation requires publish rights), and that constraint is the design: because the placeholder exists before any agent acts, there is never a question of which artifact is THE profile. The brief carries its short_id, the agent proposes against it, the page knows where the reveal lives, and a second generation attempt is just another proposal on the same artifact. No new endpoints, no publish-flag conventions.

### Data model

The Brandprint pointer gains one field: `{ collectionId?, profileId? }`. JSON in org settings, no schema change. `profileId` is validated server-side like `collectionId` (must name an artifact in the pointed collection's workspace).

Two contract details settled in the build: the personal route's request and response use a scoped schema that omits `profileId` (a sent one strips like any unknown key, so the generated client types never advertise a field the server can't return there), and the live-from-version-2 rule has one server home, core's `profileState`, with the web carrying the standard client mirror.

**`BrandprintTheme` is removed.** It has been stored, merged, validated, and typed since Phase 0 with zero consumers, and the profile's embedded tokens supersede it permanently. Delete the type from `ports.ts`, `mergeTheme` from core, the `theme` field from `BrandprintSchema`, the deep-merge handling in `workspace.ts`, and the theme cases in core tests. Phase 4 theming, if built, reads tokens from the profile artifact.

### Reference resources (the quality bar lives here)

Two static files in the repo, versioned like code, served as MCP resources to every agent:

- **`derive://brandprint/reference`**: the build guide. What a brand profile is; required sections (Essence, Personality, Color with ratios and hex, Typography, Space & Shape, Voice & Tone with on-brand/off-brand pairs, Guardrails as "never" rules, Use with AI); how to extract each from source material; and the output contract: a single self-contained HTML file, no external requests, responsive, tokens embedded twice over as CSS custom properties and a `<script type="application/json" id="brandprint-tokens">` island, so one file serves humans and machines.
- **`derive://brandprint/template`**: a brand-neutral example profile, a real polished page in the churnkey.tasteprofile.io mold, which the agent uses as its structural and quality benchmark and restyles entirely with the extracted brand. This template is the single highest-leverage artifact in the phase: agents copying a concrete gold standard produce far better output than agents following prose.

### No solicitation, ever

The MCP never pitches. Server `instructions` describe state factually and condition on the user asking: with sources but no approved profile, the line reads "This workspace's Brandprint has source material but no generated profile yet. If the user asks to build or finish their Brandprint, read `derive://brandprint/reference` and the source docs, then file the profile as a proposal on artifact `<short_id>`." So "set up my brandprint" typed into any connected agent works with no pasted brief, but no unrelated session ever gets interrupted. The persistent hand-off card on `/brandprint` is the human-facing backstop.

### Page states on `/brandprint` (workspace half)

1. **Empty**: Create Brandprint button (today).
2. **Sources saved, no proposal**: the "Finish with your agent" card, persistent: sources listed, brief ready to copy, ConnectAgent one tap away. Replaces the current saved-but-inert band's role for this scope.
3. **Proposal pending**: the reveal. Full-bleed preview, Approve, inline comments.
4. **Approved**: the profile is the page's face; sources tucked in the Documents list below; Regenerate re-surfaces the brief.
5. **No agent ever connected**: state 2 with ConnectAgent leading.

### Delivery after approval

`mcp.ts` changes one behavior: once the profile artifact has a live (approved) version, it is served as the headline resource `derive://brandprint/profile` at top priority, and the instructions line becomes "This workspace has a Brandprint profile: read `derive://brandprint/profile` before authoring; your personal Brandprint takes precedence." Source docs stay registered at lower priority for agents that want depth. Before approval, delivery is exactly today's: sources served, placeholder excluded (its only version is the stub).

### Personal Brandprint: preferences layer only

Brand is a team property; the profile treatment is workspace-only. Personal Brandprint keeps today's behavior untouched: raw docs, today's create dialog, doc-level precedence over the workspace layer, no placeholder, no `profileId`, no hand-off beat. Its real use is individual working preferences, not a second visual identity; two generated profiles per session would give agents no sane merge rule. If usage later shows the personal layer is noise, removal is a separate decision on its own evidence.

### Edge cases

- **Agent never returns after the brief**: state 2 persists; sources still function as the Brandprint.
- **Agent publishes directly instead of proposing** (publish-capable grants can): the version lands on the right artifact and the page shows state 4 without the reveal beat. Correct, just less theatrical; the brief and reference both insist on `for_review: true`.
- **Multi-file output**: proposals are single-file only, which conveniently enforces the one-file contract.
- **Onboarding Step 3 notes**: they seed source docs, which is already what the new model calls them. Only the step's closing copy changes ("your agent assembles your brand profile from this; finish on the Brandprint page").

### Testing

- **Core**: resolution with `profileId`; theme removal fallout.
- **API**: placeholder creation in the intake path; `profileId` tenancy validation; the MCP serving matrix (no profile / pending / approved) asserting resource sets and instructions copy for both states.
- **Web**: the five page states, testid'd like the rest of Brandprint; e2e remains the standing follow-up.

## Apply on demand: the Rework button (Phase 3, built on this PR)

New surface, existing plumbing. Rework is a canned version of the ask-agent handoff, scoped to the whole artifact.

### Where it lives

The artifact overflow (⋯) menu in `apps/web/src/pages/artifact/artifact-top-bar.tsx`, as a new item "Rework with Brandprint." The menu is props-driven; Rework is added as a self-contained menu-item component so the top bar stays lean and the state logic lives in one place.

### What it does

The item resolves two things: whether a Brandprint exists, then which agents are registered.

1. **No Brandprint resolved** (neither workspace nor personal): the item renders as "Set up your Brandprint" and routes to `/brandprint` instead of firing. Firing the canned instruction with zero `derive://brandprint/*` resources behind it would hand the agent an empty brief. Detection is client-side from the same sources the Brandprint page reads (workspace settings + `me.brandprint`).
2. **Brandprint set, no agent registered:** routes to the shared Connect-an-agent surface (above) instead of firing.
3. **One agent:** fires immediately. **Several agents:** opens a small picker (mirrors `AskAgentButton`).
4. Firing posts an artifact-scoped request that @mentions the chosen agent with a canned instruction, which drops into that agent's MCP pull inbox. The agent reads the request, reads its `derive://brandprint/*` resources, revises the whole document, and publishes.

Canned instruction (kept server-side as the single source of truth):

```
Rework this artifact to match our Brandprint. Read the derive://brandprint/*
resources first, then revise the whole document so its voice, structure, and
formatting match. Preserve the meaning and the facts; change how it reads,
not what it says. Publish the result as a new version.
```

When an approved brand profile exists (Phase 2), the instruction names `derive://brandprint/profile` as the first read.

Endpoint (thin wrapper over the existing @mention-to-inbox path, so the canned prompt is not duplicated in the client):

```
POST /v1/artifacts/:shortId/rework
body: { agentId?: string }   // omit to use the sole registered agent
-> { requestId }             // 409 needsAgent when the workspace has none;
                             // 409 needsBrandprint guards an empty brief
```

### Output

The agent produces a **new version**, following its grant: a publish-capable agent posts it directly; a lower-grant agent files it as a proposal for approval. This is exactly how Derive gates every other agent write, so there is no special case. Because Rework always creates a new version rather than overwriting, the original is preserved in history and the change is fully reversible.

A future "Always review Reworks" workspace setting could force the proposal path even for publish-capable agents. Out of scope for v1; the grant default covers it.

## API surface summary

Shipped (#378):

- `PATCH /v1/workspace/settings` accepts `brandprint: { collectionId?, theme? } | null` (deep merge one level, null clears; collection ownership validated).
- `POST /v1/me/profile` accepts `brandprint: { ... } | null` alongside `profession` and `about` (membership validated).

Shipped (this PR, Phase 3):

- `POST /v1/artifacts/:shortId/rework`: composes the canned @mention request server-side and posts it to the chosen or sole registered agent's inbox; `409 needsAgent` / `409 needsBrandprint`.

Not built — by design or superseded:

- Phase 2 (brand profile) added **no endpoints**, by design (#392): the placeholder rides the existing publish path, `profileId` rides the existing settings/profile PATCH routes (with the same tenancy validation), and approval is the existing proposals route. The reference resources are MCP-only.
- `POST /v1/brandprint/seed`: superseded by the shipped client-side composition. The onboarding step (#388) shipped without it, settling the open question (Decisions log #6); dead unless a future caller needs a single atomic round-trip.

Any new endpoint is defined in the contract-first Zod spec (#331), so the web client is regenerated rather than hand-written.

## Web surfaces summary

Shipped:

- `pages/brandprint/` (#383, #384, #386): the `/brandprint` page composing both scopes; the section with the create dialog (upload look/read, write, pick) and the add-docs row; the managed Documents list (the pointed collection is hidden from Collections everywhere else); rail item `nav-brandprint` under Contexts.

- `components/shared/connect-agent.tsx` (#388): shared Connect surface extracted from `welcome.tsx` Step 2, plus `ConnectAgentButton`; backs onboarding, the library empty state, the home nudge, and the `/brandprint` inert band.
- `pages/welcome.tsx` (#388): skippable Step 3 with the Brandprint explainer and notes intake via the shared `useBrandprintImport` hook.
- `pages/library/brandprint-nudge.tsx` (#388): one-time dismissible owner nudge on the home library.

Shipped (#392):

- `pages/brandprint/profile-panel.tsx`: the hand-off card (three-line brief through the shared PromptBlock, ConnectAgent one tap away), the polled reveal (full-width proposal preview, Approve, Review & comment), and the live profile with Regenerate. The page mounts it instead of the inert nudge whenever `profileId` is set.
- `pages/brandprint/profile-placeholder.ts` + `use-brandprint-import.ts`: every workspace pointer-write (intake, picker, or the dialog's collection tab) seeds the placeholder and stores `profileId`; the docs list hides the profile artifact, since the panel is its home.
- Onboarding Step 3: closing copy points at the Brandprint page to finish (one string).

Built (this PR, Phase 3):

- `pages/artifact/rework-menu-item.tsx` + `rework-state.ts`: the "Rework with Brandprint" ⋯ item, four-state per the gate above, mounted from `artifact-top-bar.tsx`.

## Testing

Shipped coverage (#378, #383):

- **Core:** `resolveBrandprint`, `parseBrandprint`, `brandprintInstructions` unit tests.
- **API:** workspace and profile patches merge and clear correctly; foreign and unknown `collectionId` rejected on both write paths; storage round-trips across sqlite/pg/d1.
- **MCP:** an end-to-end test seeds a collection, points the workspace at it, and asserts the `derive://brandprint/*` resources and instructions pointer.
- **Web:** none yet; the create dialog and page carry testids (`brandprint-create-*`, `brandprint-upload-look/read-*`, `brandprint-notes-*`, `brandprint-pick-collection-*`, `nav-brandprint`) for an e2e follow-up.

Coverage added with the later phases:

- **Phase 2: written in #392** — `profileId` tenancy on both routes, the MCP serving matrix (pending and live states, reference resources), and `profileState`. Still standing: the page states carry testids for the e2e follow-up, and the agent-in-the-loop run (brief → proposal → approve → next session reads the profile) is a manual pre-merge pass.
- **API (Phase 3): written (this PR)** — `rework.test.ts` covers the gates (`needsAgent`, `needsBrandprint`, cross-workspace 404s) and the firing (sole-agent default, chosen agent among several, a live profile named as the first read), asserting the canned @mention lands in the agent inbox.
- **Web (Phase 3): written (this PR)** — the four-state resolver test (`rework-state.test.ts`) covers set-up / connect / fire / picker. Still standing: onboarding Step 3 renders, saves, and skips; an e2e over the create dialog.

## Phasing

- **Phase 0 (foundation): shipped** (#378). Anir's Phase A ported forward, renamed, with the cross-tenant ownership validation added in review.
- **Phase 1 (capture): shipped** (#383, #384, #386, #388). The create dialog on the `/brandprint` page, the docs' one home, the shared ConnectAgent surface, onboarding Step 3, and both nudges. No seed endpoint, settled.
- **Phase 2 (the brand profile): shipped** (#392). The hand-off flow, the placeholder-proposal mechanics, the two reference resources, the page states, profile-first delivery, and the `BrandprintTheme` removal.
- **Phase 3 (apply): built (this PR).** The Rework ⋯ item (gated on a Brandprint existing), the rework endpoint, and the no-agent routing.
- **Phase 4 (later, optional):** agent enrichment of the Brandprint doc, visual theme application fed by the profile's embedded tokens, and an "Always review Reworks" setting.

## Decisions log

Resolved during review and build, reflected in the body above:

1. **Collection, not single doc.** Brandprint points at a collection so a team can grow from one seeded doc to several with no migration.
2. **Onboarding is workspace-scoped and conditional.** The first person to set up a workspace's Brandprint sees the step and it creates the workspace Brandprint. Anyone joining a workspace that already has one never sees the step and inherits it automatically.
3. **Enrichment is deferred.** "Expand my notes into a fuller style guide" waits for a later phase (Phase 4). v1 stores raw pasted notes, which are a valid Brandprint on their own.
4. **Brandprint is a top-level destination** (#384). Promoted out of Settings to `/brandprint` in the rail, a peer of Contexts, so the workspace and personal halves read as one feature.
5. **Capture asks for both halves of the brand** (#383). The upload intake splits into "how your artifacts should look" and "how your artifacts should read." Either alone works; both are first-class, and the split guides the profile's extraction (Phase 2).
6. **No seed endpoint** (#383, settled in #388). The intake shipped as client-side composition of existing endpoints inside one governed mutation, and the onboarding step seeds through the same shared hook, so `POST /v1/brandprint/seed` stays unbuilt.
7. **Rework gates on a Brandprint existing.** With none resolved, the ⋯ item reads "Set up your Brandprint" and routes to `/brandprint`; the canned instruction never fires against zero convention docs.
8. **The Brandprint collection is not a Collection, to users** (#386). It stays a collection in the data model (the delivery layer reads it unchanged), but it never surfaces in the rail, palette, or organize dialogs; its docs are managed on `/brandprint` only, so the files and the options have one home.
9. **The Brandprint culminates in a generated brand profile** (Phase 2, the tasteprofile.io take). Generation is the create flow, not an upgrade: uploads become source material, the user's own agent assembles one self-contained HTML profile, and a reveal-plus-Approve proposal gates it before any agent is steered by it. The reveal doubles as a first-run demo of the publish → review → revise loop.
10. **Derive never runs inference and never solicits.** The Derive side of generation is static reference resources over MCP plus factual, user-conditioned instructions. No Derive-owned agents, no inbox pushes for generation, no pitching in unrelated sessions; the persistent hand-off card on `/brandprint` is the backstop.
11. **One HTML file carries both audiences.** The profile embeds its tokens as CSS custom properties plus a JSON island, so humans get the beautiful page and machines get structured data from the same artifact. `BrandprintTheme` is removed as superseded, having shipped in Phase 0 with zero consumers.
12. **The placeholder is the recognition contract.** Created at intake time, its short_id rides the brief and the proposal, so which artifact is THE profile is never inferred from conventions.
13. **Personal Brandprint stays a preferences layer.** Profiles are workspace-only; the personal half keeps raw-docs behavior and doc-level precedence. Two generated profiles per session would have no sane merge rule. Shipped in #392 as a scoped schema: the personal route's request and response omit `profileId`.
14. **Rework moves to Phase 3.** The profile outranks it: it upgrades what every agent session reads by default, while Rework upgrades one artifact on demand, and Rework's canned instruction gets better the moment a profile exists.
