# Contexts: guided, conversational creation — design

**Date:** 2026-08-05
**Status:** approved by Connor (chat brainstorm), pending spec review
**Problem:** Building a first context today requires knowing the whole concept stack up front. The create form asks for a "manifest short id" (you must have authored and published a manifest artifact elsewhere, with no guidance on what it should contain), and success hands you a one-time runner token plus `derive runner serve` CLI instructions. A non-technical user hits two walls — "what is a manifest" and "what do I do with this token" — before any win.

**Goal / success test:** Someone who does not use LLMs regularly, on hosted Derive, has a conversation with Derive in the browser, approves a summary, and owns a working context their team's agents can read. Under two minutes, zero terminal, zero jargon. It should feel like briefing a teammate, not filling in a form.

## The experience

### One door: talk to Derive

"New context" opens a conversation on the existing chat surface (`apps/web/src/pages/chat` patterns — same message list, same voice, same permission note style). Derive opens with one question, in the product's plain voice: "What should this context know or do? Describe it like you'd brief a new teammate."

The user answers in prose. Derive asks follow-ups only when genuinely needed (cap ~3: e.g. "Should it answer from these docs only, or general knowledge too?", "Who should be able to ask it questions?"). The user can attach or name existing artifacts for it to learn from; Derive can also suggest candidates it finds (via the same workspace search chat already uses, with the user's own permissions).

### The model writes the manifest

When Derive has enough, it says so and shows a **context card** inline in the conversation — a friendly preview, not the manifest source:

- name + one-line description
- "What it knows" (the knowledge scope, with links to any source artifacts)
- "How it answers" (tone/format commitments it inferred)
- "What it won't do" (honest limits)
- kind: knowledge pack vs worker (see fork below)

One button: **Create**. Edits happen conversationally ("make it stick to the pricing docs") — the card revises in place. Behind the button: publish the manifest artifact (standard header comment explaining what the file is, so anyone opening it later understands), then `create_context` with it. The user never sees a short id.

### The purpose fork is inferred, not asked

The model classifies the context from the description and the card says what that means:

- **Knowledge pack** (default): "Your team's agents can read this immediately." No runner, token, or serving concept appears anywhere in the flow.
- **Worker** ("it should answer questions / do tasks on its own"): the card adds one sentence — "Answers come from whoever runs it. You can serve it from your own agent session, or set up a dedicated runner later." The token flow moves entirely behind a "Set up a dedicated runner" affordance on the context page (existing UI), reworded in plain language.

First success is read-oriented for knowledge packs and never blocks on the runner question for workers.

### Second door: your agent builds it

The create surface offers the equal alternative — "Prefer your own agent to build this? Copy this prompt." The prompt instructs any connected agent (Claude Code, Codex) to interview the user and wire the context over MCP (`automate` `create_context` + `publish`), which works today with no product changes. Team-agent workspaces get the same outcome through whichever door fits.

### Degraded mode: no model on this deploy

Self-hosted deploys without chat configured (`DERIVE_MODEL_BASE_URL` / Anthropic key absent) show the second door as the primary path, plus the existing expert form behind "I already have a manifest". Feature-parity rule holds: nothing hosted-only except the convenience of the built-in author.

### Explainers where the confusion actually was

- Page intro and empty state rewritten in plain language; no "packaged agent / versioned manifest / runner" in a first sentence.
- Status dots ("online / offline / never connected") get hovers that say what it means and that **reading still works while offline**.
- The expert form remains reachable ("I already have a manifest") for people who authored one deliberately.

## Architecture

- **Frontend:** a create-context conversation mode on the chat surface. Reuses the chat message components and streaming; adds the inline context card component and the two-door create entry. The old `NewContext` form moves behind the expert affordance.
- **Backend:** one addition — a context-builder chat tool surface: the conversation runs on the existing attended-chat machinery (`chat-turn.ts`, `model-catalog.ts`) with a system prompt for the builder role and two tools scoped to it: `draft_manifest` (returns the card payload) and `create_context_from_draft` (publishes the manifest artifact + calls the existing create path, returning the context id). No new tables; a context created this way is indistinguishable from one created by hand.
- **Auth/limits:** same gates as chat today (workspace chat enablement, existing rate limits). Creating still requires the roles the current API requires; the conversation checks this up front and says so plainly instead of failing at the end.

## Error handling

- Model unavailable mid-conversation: the transcript survives (chat semantics), user can resume; the copyable-prompt door is offered inline.
- `create_context` failure after manifest publish: the card reports it plainly and offers retry; the published manifest artifact is linked so nothing is lost.
- Classification wrong (knowledge vs worker): user says so in the conversation; the card re-renders. No settings archaeology.

## Testing

- Unit: builder-tool contract tests (draft → card payload shape; create → artifact + context rows) alongside the existing context API tests.
- Web: conversation → card → create happy path; degraded (no model) path shows the right doors; expert form still reachable and functional.
- Copy check: the conversation flow and context card render no instance of "manifest", "short id", "runner token", or "serve" (a literal assertion, since that is the point). The expert door's own label ("I already have a manifest") is the one allowed exception, excluded by test id.

## Out of scope (deliberate)

- Hosted runner fleet or any new serving infrastructure.
- Billing changes.
- Multi-step wizard UI (the conversation IS the wizard).
- Editing existing contexts conversationally (create-only for v1).
- Changes to the MCP tool surface (PR #644 territory; the agent door uses what exists).
