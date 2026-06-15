# Dock — agent skill

Dock hosts an artifact (HTML, Markdown, or a static bundle) at a permanent,
versioned URL with inline comments. An agent connects to Dock's **remote MCP
server** over Streamable HTTP (OAuth-authenticated — no static token) and drives
the **read → revise → publish** loop. The agent acts at **its own role**: what it
can do is exactly what that role can do.

Connect (Claude Code / claude.ai / Claude Desktop):

```
claude mcp add --transport http dock <your-dock-server>/mcp
```

The first call triggers an OAuth consent in the browser; you grant the agent a
scope, and that scope maps to a role (read-only, propose, or publish).

## Tools

| Tool | Use |
|---|---|
| `whoami` | Your agent name, workspace, and role. Call first to confirm the connection. |
| `list_artifacts` | The artifacts in your workspace (short id, title, kind, version, visibility). |
| `read_artifact` | One artifact's metadata + current source. |
| `read_section` | A single page of a multi-page bundle (or a single-file artifact's content). |
| `list_versions` | Version history, newest first. |
| `diff` | What changed between two versions. |
| `list_comments` | The review feedback (open / resolved threads with anchors) — the agent's to-do list. |
| `catch_me_up` | One coalesced delta since a version: new versions, pages changed, entry diff, open comments. |
| `propose` | Submit a revised single-file version **for human review** — does NOT go live. Commenter+ role. |
| `publish` | Publish a revised single-file version **directly — it goes live now**. Requires Creator/Admin role. |

## Role decides publish vs propose

`publish` and `propose` are gated on **your role** (the scope you were granted):

- **Admin / Creator (editor+)** → `publish` directly (live immediately), or `propose` if you want review.
- **Commenter** → `propose` only (a human approves it before it goes live).
- **Viewer** → read-only.

So an agent you authorize with a publish scope publishes exactly as you would; a
lower-scoped agent can still read and propose, but can't push live content.

## The loop

1. **`whoami`** → confirm your workspace + role.
2. **`catch_me_up`** (or `list_comments` state `open`) → the feedback to address.
3. **`read_section` / `diff`** → understand a comment in context.
4. **Revise**, then **`publish`** (if you're Creator/Admin) or **`propose`** (commenter)
   — same URL, a new version. Comment highlights re-anchor to the moved text.

## Keep comments anchorable

Anchors are text quotes with surrounding context, matched in the rendered
document. They survive edits when the text stays recognizable: make local edits,
keep headings and distinctive phrases stable, and prefer real text over images of
text. A comment whose text is gone is shown as "text changed", never moved to the
wrong place.

## Notes

- Versions are immutable; `@vN` URLs never change. The viewer groups rapid
  same-author revisions into time-based sessions, but every revision is addressable.
- Multi-page bundles are readable (`read_section`, `diff`, `catch_me_up`) but not
  yet revisable over MCP (`propose`/`publish` are single-file only).
