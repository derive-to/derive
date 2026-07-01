# Derive: new collaboration modes and the publish gate

Today every comment on Derive is the same kind: public, human-to-human, a discussion.
That is one quadrant of a larger space. This plan adds the missing quadrants and a
quality gate, all on the anchor primitive from
[element-anchors.md](./element-anchors.md). Companion to
[collaboration-layer.md](./collaboration-layer.md).

## Two axes

A comment has two independent properties:

- **Visibility:** private (just me and my agent) or public (the whole team).
- **Intent:** an instruction (something to act on, then resolve) or a discussion
  (a thread to talk through).

Existing comments are public discussion. The two modes below fill the rest, and
both reuse the layered anchor and the existing `add_comment` plumbing. The work is a
comment `kind`, a visibility scope, and the review UI.

## Mode A: private-to-your-agent comments

The same anchored comment, scoped to the author and their agent. Nobody else sees
it, and because comments are already an overlay served separately from the artifact
bytes, **it can never leak into a shared file.** The portability principle is also
the privacy guarantee.

What it is for: driving revisions while you are still iterating, before you share
anything publicly. You anchor "redo this chart, the axis is wrong" to the chart;
your agent reads it over MCP, revises, and resolves it, the same publish to read
comments to revise loop that already exists, just on a private channel.

These are instructions, so they **drain**: an addressed private comment resolves and
clears, rather than living forever as a discussion thread.

Data shape: a `visibility: "private"` flag on the comment and an `intent:
"instruction"` kind. Private comments are filtered out of every list a non-author
sees, server-side, and are never included in a published version's resolved-thread
trail.

## Mode B: agent-authored uncertainty

The inverse direction, and the more novel one. The agent leaves anchored markers on
its **own** output wherever it guessed: "assumed Q3 here, confirm," "could not find
the real figure, placeholder." A distinct comment kind, authored by the agent,
surfaced to you as you review.

Why it matters: you review the flagged-risk spots instead of re-reading everything.
It turns the agent into a participant that reports its own confidence, not just a
generator that hands you a wall of output and hopes.

The plumbing already exists: agents can `add_comment` with an anchor today. So this
is mostly a new `intent: "uncertainty"` kind plus review UI that treats it as
**confirm / dismiss** rather than a discussion thread. Confirming clears it;
dismissing can hand the spot back to the agent as a private instruction (Mode A),
closing the loop.

## The publish gate

A headless layout audit that runs **at publish time**, before a share link goes out.
Derive has nothing here today.

The audit inspects the rendered output for:

- page horizontal overflow
- element overflow (content wider than its scroll container)
- clipped text (content hidden by `overflow: hidden`, excluding intentional
  ellipsis or line-clamp truncation)
- overlapping text (two elements colliding over readable text)

Each finding carries a `selector`, a `kind`, an overflow measurement, and a
`severity` (warning or error on a small pixel threshold). On an error-severity
finding we **warn or block** before publishing, naming the specific elements, rather
than letting a visibly broken artifact reach a teammate.

It is a pre-publish check, not a runtime nag: silent on success, one quiet panel on
failure listing exactly what overflowed or clipped. Implementation runs the audit in
the same sandboxed render path the viewer already uses, so it sees the artifact the
way a reader will.

## How the pieces fit the lifecycle

1. **Drafting (private).** You and your agent iterate. Private instructions (Mode A)
   drive revisions; the agent flags its own doubts (Mode B). Nothing is shared.
2. **Publishing.** The layout gate runs. A broken layout is caught here, not by a
   reviewer.
3. **Reviewing (public).** You share; public discussion comments open. The same
   anchors, now visible to the team.

The private and public layers are the same mechanic with visibility flipped, which
is why this is depth on the existing share flow, not a separate product.

## What stays true

All of this rides the overlay model. Private comments, agent-uncertainty markers,
and the audit operate beside the artifact bytes, never inside them. The shared file
stays self-contained, portable, and identical everywhere it is opened.

## Phasing

1. `visibility` and `intent` fields on comments; server-side filtering of private
   comments; CLI/MCP support for setting them.
2. Mode B review UI (confirm / dismiss) and the dismiss-to-private-instruction loop.
3. The publish-gate audit in the render path; the pre-publish panel; block-or-warn
   policy (default warn, opt-in block per workspace).

## Open questions

- Does a private comment survive when you later publish, becoming visible, or stay
  private forever? Proposed: private is sticky; "promote to public" is an explicit
  action, never automatic, so nothing leaks by surprise.
- Agent identity on Mode B markers: one agent, or attributed per agent/run? Start
  with a single "agent" author, like `add_comment` today.
- Should the publish gate ever hard-block, or only warn? Default warn; let a
  workspace opt into blocking on error-severity findings.
