# What Claude's artifact tooling teaches Derive

Source: a dogfooding session (2026-07-11) where Claude Code published a fully-styled
HTML artifact to Derive via the remote MCP, followed by a comparison against the same
agent's *native* artifact tooling — its Artifact tool description, the `artifact-design`
skill it is required to load before authoring, and the harness behavior around
publishing. PR #399 shipped the first round of fixes (fonts as assets, reflow escape
hatch, `content_sha256`, honest tool copy). This doc holds the rest, ranked by leverage.

## 1. Take content by file path, not by string (stdio MCP) — SHIPPED with this doc

Claude's Artifact tool takes a **file path**; the harness reads the bytes itself, so
page content never travels through the model's token stream. Derive's `publish` takes
`content` as a string — which is how an 18KB font ended up transcribed by a language
model and silently corrupted by one wrong character.

The remote `/mcp` can't read files, but `packages/mcp` (the stdio shim) runs on the
user's machine with fs access. `content_path` there reads the file and POSTs the bytes:
zero tokens for the page, no transcription surface, and it nudges agents into the
healthy loop (build locally → verify → publish). Pairs with `content_sha256`: the shim
can verify the echo against the local file automatically.

## 2. Close the visual verification loop server-side (issue)

The dogfooding bug (a font that failed to parse and silently fell back) was only caught
because the agent had Playwright to screenshot what Derive actually served. Most agents
won't — they publish a broken page and report success. Derive already runs a
preview-render pipeline (#394 enqueues renders on MCP publish); surfacing it to agents —
a `preview_png` URL in the publish response, or a `get_render` tool — makes
"publish, then look at what you shipped" the default agent loop. Claude's ecosystem has
no equivalent; this is a place Derive can lead.

## 3. A theme contract for artifact pages (issue)

Claude artifacts render in the viewer's light/dark theme: the harness stamps
`data-theme` on the artifact's root element when the viewer toggles, and the tool
description prescribes the CSS pattern (tokens on `:root`, `prefers-color-scheme` as
the default signal, `:root[data-theme]` overrides that must win in both directions).
Derive deliberately doesn't touch iframe content — but it already injects a script into
every served HTML page (the anchor client) and runs a postMessage protocol with the
host. Stamping the app theme onto the frame's `<html>` plus documenting the token
pattern is small, and it fixes dark-mode users getting a blinding white page. Pages
that ignore the contract behave exactly as today.

## 4. Detection-driven nudges in the publish response — SHIPPED with this doc

The best teaching in Claude's tooling happens in tool *results*, not descriptions.
Derive already does this (the `note` field) and already sniffs published HTML
server-side (viewport detection, content-type self-heal). Combining them: when a
publish will get the mobile-reflow injection (no viewport meta), or embeds large
base64 data URIs that should be assets, say so in the response note — a rule delivered
at the moment of the mistake beats one buried in a 200-word description.

## 5. Craft guidance as a reference resource, composed with Brandprint

Before authoring an artifact, Claude is required to load a design skill: treatment
calibration (a memo is not a landing page), a typography/palette method, and an
explicit list of AI-default aesthetics to avoid. That skill is a large part of why its
artifacts stopped looking samey. Derive's SKILL.md covers mechanics; nothing teaches
craft.

The Brandprint-of-skills architecture (#397) already defines the right slot:

- Ship the method as a **static reference resource** (`derive://design/reference`),
  a sibling of `brandprint-reference.ts` — versioned like code, zero setup, no
  inference run by Derive. It teaches the brand-agnostic method: calibrate treatment,
  pair typefaces deliberately, structure-as-information, the anti-slop list.
- **Brandprint supplies the values; the design reference supplies the method.**
  Claude's skill is brand-neutral with a placeholder palette to swap — Derive's version
  says "swap in the tokens island from `derive://brandprint/profile`." The profile's
  machine-readable tokens island is exactly the swap target, and the existing
  precedence chain extends naturally: method defaults < workspace Brandprint <
  personal Brandprint.
- Teams that want to tune the aesthetic rules themselves fork it as a workspace
  **skill** (the #397 machinery makes those discoverable at connect with their own
  frontmatter identity) — same pattern as customizing a scout.
- Wire-up is one pointer: the publish description (and the server instructions, next
  to the Brandprint line) says "authoring a styled page? read `derive://design/reference`
  first."

## 6. Identity discipline (small, later)

Claude's tool copy is obsessive about artifact identity: same path → same URL, stable
title, stable per-artifact emoji favicon ("users find their tab by its icon"), new URL
only on a hard pivot. The failure it guards — an agent minting a new artifact when the
user meant "update the existing one" — applies to Derive verbatim, and copy is weak
protection. Stronger: `publish` without `short_id` where a similar-titled artifact
exists in the workspace returns a soft `did_you_mean: <short_id>` alongside the create.
The per-artifact emoji favicon is a small, charming tab-navigation feature.

## Already at parity or ahead — don't touch

Private-by-default with human promotion (identical philosophy); version messages and
named checkpoints (≈ Claude's version labels); teaching-in-results; `edits` (Claude has
no surgical publish — full rewrites only); the asset store + sandboxed-but-networked
serving (strictly more capable than Claude's everything-inline CSP, which forces
base64-ing every image into the page). The gap was never capability — Claude's tooling
*narrates* its capabilities and constraints relentlessly, and Derive's now does too.
