# Dock: the collaboration layer

Dock is where a team of humans and AI work together on a shared artifact. Sharing
is the foundation. Collaboration is what we build on top of it.

The frame for everything below: **the artifact is the meeting point.** Sharing got
everyone into the same room. The rest is how they actually work together on the
thing in front of them, humans and agents alike, on the artifact and not beside it.

This doc is the north star. Two companion plans break out the concrete work:

- [element-anchors.md](./element-anchors.md) - let a comment land on a chart,
  image, diagram, or slide region, not just prose, and make every anchor a layered
  cascade so feedback survives revisions instead of vanishing when content moves.
- [collab-modes-and-publish-gate.md](./collab-modes-and-publish-gate.md) - private
  agent comments, agent-authored uncertainty, and a layout audit at publish time.

## What already exists (the spine)

We are not starting from zero. The collaboration spine is already in place, and on
the one axis that matters most (feedback surviving a revision) it is already good:

- **Versioned sharing.** Every artifact has a permanent URL, content-addressed
  versions, and a sandboxed viewer. This is the foundation.
- **Anchored comments.** Comments anchor to a W3C `TextQuoteSelector`
  (`exact` plus `prefix`/`suffix` context) and re-anchor on every republish: exact
  match with context first, then exact anywhere, else marked "text changed." A real
  three-tier rehydration strategy, not a brittle character offset.
- **The anchor-client protocol.** A served (not inlined) `/raw/dock-client.js`
  talks to the sandboxed iframe over `postMessage` (`select`, `anchors-resolved`,
  `anchor-click`). The comment layer evolves independently of frozen artifact
  bytes, so portability is already solved. See [STANDARD.md](../../STANDARD.md).
- **The review loop.** Proposals (candidate versions awaiting review), approve,
  reply, resolve, reopen. Agents run the same loop over MCP and the CLI.
- **Teams.** Workspaces, memberships, roles, realtime presence over SSE.

## The thesis

Most "share a doc" tools stop at read-only. Dock's bet is that the shared artifact
becomes a workspace the moment feedback lands **on** it, anchored to a specific
spot, from any participant: a teammate, a reviewer, or an agent. AI is a
participant in that conversation, not just the thing that generated the page.

That reframes the three moves below. They are not "comment features." Each one
extends what a participant can do on the shared object:

| Move | What it unlocks | Plan |
|---|---|---|
| Layered anchoring | React to the visual parts of an artifact, and keep every comment attached as content moves | [element-anchors.md](./element-anchors.md) |
| New collaboration modes | Talk privately to your own agent; let the agent flag its own doubts | [collab-modes-and-publish-gate.md](./collab-modes-and-publish-gate.md) |
| Publish gate | Keep a broken-looking artifact from ever reaching a teammate | [collab-modes-and-publish-gate.md](./collab-modes-and-publish-gate.md) |

## What we are deliberately not doing

- **Not throwing away the existing anchoring.** Text quotes and their republish
  rehydration stay exactly as they are. The layered-anchoring plan wraps more
  fallback locators around that proven core and extends it to non-text elements; it
  does not replace `TextQuoteSelector`.
- **Not repositioning Dock.** This is depth on the existing share flow, not a new
  product. Sharing stays the front door.
- **Not baking chrome into artifacts.** See the principle below.

## The principle that holds it together

Comments and chrome are an **overlay, served separately, never baked into the
artifact bytes.** The shared file renders identically whether you open it on Dock,
download it, or hit the raw URL. Every move respects this: it is what keeps
artifacts portable, and it is also what keeps private feedback from ever leaking
into a public file. When a plan below proposes new data, the test it must pass is:
*does the published artifact byte-for-byte stay the same?* If not, it goes in the
overlay, not the file.

## Sequencing

1. **Layered anchoring** first. It closes the real gaps in the core primitive
   (non-text targets, and durability as content moves), and the later modes are more
   useful once any part of an artifact can carry a comment that survives revisions.
2. **New collaboration modes** second. Private agent comments and agent uncertainty
   reuse the anchor primitive (text and, after step 1, element) and the existing
   `add_comment` plumbing; the work is mostly a comment `kind`, a visibility scope,
   and the review UI.
3. **Publish gate** as a fast follow. It is independent of the other two and cheap:
   a headless audit at publish, surfaced as a pre-publish check.
