# Dock

Dock gives AI-built content a permanent home: a real URL, versioned history, threaded
comments anchored to the text, and a review loop so humans stay in control.

Read this first. It maps the whole system. Then go to the skill that matches your task.

---

## Core model

```
artifact
  ├── versions (immutable snapshots, n=1,2,3...)
  ├── comments (anchored to exact text, threaded, open or resolved)
  └── proposals (candidate versions awaiting human approval)
```

- **Artifact**: a file (HTML, Markdown, or HTML deck) with a permanent short_id and URL.
- **Version**: every publish call creates a new immutable version. The URL stays the same; the content updates. Old version URLs (`/raw/:id/v/:n/index.html`) never change.
- **Comment**: a thread anchored to a passage of text. The anchor is a W3C TextQuoteSelector (`{ exact, prefix, suffix }`) — it re-matches after edits as long as the text stays recognizable.
- **Proposal**: a candidate version that doesn't go live until a human approves it. The safe path for agents with commenter role.

---

## Artifact types

| Type | Filename hint | What you get |
|---|---|---|
| Markdown | `notes.md` | Rendered prose: GFM, tables, code blocks, task lists |
| HTML | `page.html` | The page itself, sandboxed (no cookies, no cross-origin) |
| HTML deck | `deck.html` | Navigable slide deck — nav bar + present mode auto-wired |

---

## Roles

| Role | Can do |
|---|---|
| viewer | Read public/link artifacts |
| commenter | Read + comment + propose (default for agents) |
| editor | + publish versions + approve proposals |
| manager | + share + change visibility |
| owner | Everything |

An agent token defaults to commenter. To publish directly, the agent needs editor role.

---

## Two MCP servers — choose one

| | STDIO MCP (`@dock/mcp`) | HTTP MCP (`/mcp`) |
|---|---|---|
| **Auth** | Static `dk_agt_` token | OAuth 2.1 bearer |
| **Connect via** | Claude Code `.claude/mcp.json` | claude.ai / Claude Desktop OAuth flow |
| **Writes** | Direct publish — no approval gate | Propose only — human approves before live |
| **Sync tool** | `list_comments` + `get_artifact` | `catch_me_up` (coalesced delta) |
| **Best for** | Trusted agents, CI, solo use | Collaborative, human-in-the-loop |

---

## The loop — STDIO MCP

1. `publish_artifact` — get a `short_id` and URL. Share it.
2. `list_comments(state: "open")` — read the feedback queue.
3. `get_artifact` — read the current source.
4. Revise the content.
5. `publish_version(resolves: [commentId, ...])` — new version, threads closed atomically.
6. Repeat from 2.

---

## The loop — HTTP MCP

1. `catch_me_up(short_id, since_version)` — coalesced delta: new versions + diff + open threads.
2. `read_section` to drill into changed pages; `diff` for exact line comparison.
3. `propose(content, message)` — candidate version, not live. Human approves or requests changes.
4. On approval Dock publishes it and re-anchors comments. Loop.

Comments re-anchor to moved text automatically. If the quoted text is deleted, the comment
shows "text changed" — it never attaches to the wrong place.

---

## MCP tools (quick reference)

**STDIO MCP** (token-based, direct publish):

| Tool | When to use |
|---|---|
| `publish_artifact` | First publish of new content |
| `publish_version` | Revised version; pass `resolves` to close threads |
| `get_artifact` | Read current (or past) source + metadata |
| `list_versions` | Version history |
| `diff_versions` | What changed between two versions |
| `restore_version` | Roll back (creates new version, preserves history) |
| `list_comments` | Feedback queue |
| `add_comment` | New thread; pass `quote` to anchor to text |
| `reply_comment` | Reply in existing thread |
| `resolve_thread` | Close (or reopen) a thread |
| `view_stats` | View counts |

Resource: `dock://guide` — the agent loop guide as a readable MCP resource.

**HTTP MCP** (OAuth, propose-only):

| Tool | When to use |
|---|---|
| `catch_me_up` | Session start — coalesced delta since `since_version` |
| `list_artifacts` | Enumerate workspace artifacts |
| `read_artifact` | Metadata + content for single-file artifacts |
| `read_section` | Per-page content for bundles; omit `path` to list pages |
| `diff` | Line diff between two versions |
| `list_comments` | Feedback queue |
| `list_versions` | Version history |
| `propose` | Submit candidate version for human review |
| `whoami` | Confirm connection + role |

---

## Skill map

**Getting started**
- `dock-connect.md` — get a token, wire MCP to Claude Code or Claude Desktop

**Publishing & versioning**
- `using/dock-publish.md` — publish_artifact, publish_version, versions, CLI, API
- `using/dock-proposals.md` — the propose -> review -> approve loop

**Feedback**
- `using/dock-comments.md` — anchors, threads, reactions, mentions

**Writing content**
- `formats/dock-markdown.md` — writing Markdown artifacts
- `formats/dock-html.md` — writing HTML artifacts (sandbox, anchoring)
- `formats/dock-deck.md` — writing HTML slide decks (deck protocol)

**Deployment**
- `running-locally/dock-self-host.md` — local dev, single container
- `deploying/dock-node.md` — Node Basic + Node Scale
- `deploying/dock-cloudflare.md` — Cloudflare Basic + Cloudflare Scale
