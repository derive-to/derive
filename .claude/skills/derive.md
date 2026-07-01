# Derive

Derive gives AI-built content a permanent home: a real URL, versioned history, threaded
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

## Two MCP servers (same 5 tools)

Both the stdio `@derive/mcp` server and the remote `/mcp` server expose the same 5
tools (`list_artifacts`, `read`, `catch_up`, `comment`, `publish`). The difference is
auth and how writes land:

| | STDIO MCP (`@derive/mcp`) | HTTP MCP (`/mcp`) |
|---|---|---|
| **Auth** | Static `dk_agt_` token | OAuth 2.1 bearer |
| **Connect via** | Claude Code `.claude/mcp.json` | claude.ai / Claude Desktop OAuth flow |
| **Writes** | `publish` goes live or files a proposal based on role | Same; OAuth scope maps to role |
| **Caveats** | Bundles are publish-via-remote/web only; `comment` set_state takes a `comment_id` | Full bundle publish via `publish` `files` map |
| **Best for** | Trusted agents, CI, solo use | Collaborative, human-in-the-loop |

---

## The loop

1. `catch_up(short_id, since_version)` gives the state in one call: what changed, the open
   feedback threads, and version history. Pass `comments` (open/addressed/resolved/outdated)
   for a filtered feedback queue, or `response_format='detailed'` to fold in the exact line diff.
2. `read` returns content by short id; for a bundle omit `section` for the outline or pass a
   `section` (page path) for one page; pass `version` to read history.
3. Revise the content.
4. `comment` (reply with `reply_to`, resolve/reopen with `set_state`) and/or
   `publish` (pass `addresses` to resolve the threads this revision fixes): same URL, a
   new version, threads closed atomically.
5. Repeat from 1.

Comments re-anchor to moved text automatically. If the quoted text is deleted, the comment
shows "text changed" — it never attaches to the wrong place.

---

## MCP tools (quick reference)

The same 5 tools on both servers:

| Tool | When to use |
|---|---|
| `list_artifacts` | Find the artifacts in your workspace (short id, title, kind, version, visibility); optional `query` filters by title |
| `read` | Read content by short id; bundles take a `section` (page path) and any tool takes a `version` for history |
| `catch_up` | Start here on an artifact: what changed since `since_version`, open/outdated threads, and version history; pass `comments` for a filtered feedback queue, or `response_format='detailed'` for the line diff |
| `comment` | Leave feedback, reply (`reply_to`), anchor to a `quote`, and/or resolve/reopen (`set_state`) |
| `publish` | Save a revision (`content` for one file, `files` for a bundle); omit `short_id` to create new, pass it to add a version; `addresses` resolves threads; goes live or files a proposal based on role, or `for_review:true` |

Resource: `derive://guide` — the agent loop guide as a readable MCP resource.

---

## Skill map

**Getting started**
- `derive-connect.md` — get a token, wire MCP to Claude Code or Claude Desktop

**Publishing & versioning**
- `using/derive-publish.md` — `publish` (new + versions), versions, CLI, API
- `using/derive-proposals.md` — the propose -> review -> approve loop

**Feedback**
- `using/derive-comments.md` — anchors, threads, reactions, mentions

**Writing content**
- `formats/derive-markdown.md` — writing Markdown artifacts
- `formats/derive-html.md` — writing HTML artifacts (sandbox, anchoring)
- `formats/derive-deck.md` — writing HTML slide decks (deck protocol)

**Deployment**
- `running-locally/derive-self-host.md` — local dev, single container
- `deploying/derive-node.md` — Node Basic + Node Scale
- `deploying/derive-cloudflare.md` — Cloudflare Basic + Cloudflare Scale
