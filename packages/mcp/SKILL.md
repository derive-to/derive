# Derive — agent skill

Derive hosts an artifact (HTML, Markdown, or a static bundle) at a permanent,
versioned URL with inline comments. An agent connects to Derive's **remote MCP
server** over Streamable HTTP (OAuth-authenticated — no static token) and drives
the **read → revise → publish** loop. The agent acts at **its own role**: what it
can do is exactly what that role can do.

Connect (Claude Code / claude.ai / Claude Desktop):

```
claude mcp add --transport http derive <your-derive-server>/mcp
```

The first call triggers an OAuth consent in the browser; you grant the agent a
scope, and that scope maps to a role (read-only, propose, or publish).

Your identity (agent name, workspace, role) is in the server instructions — there is no `whoami` tool.

## Tools

| Tool | Use |
|---|---|
| `list_artifacts` | Find: the artifacts in your workspace (short id, title, kind, version, visibility). Optional `query` filters by title. |
| `read` | Read an artifact's content by short id. For a bundle, omit `section` for the outline or pass a `section` (page path) for one page; pass `version` to read history. |
| `catch_up` | Start here on an artifact: its state in one call — what changed since `since_version`, the open/outdated comment threads, the `review` round state, and version history. Pass `comments` (open/addressed/resolved/outdated) for that filtered feedback queue, or `response_format='detailed'` (with optional `since_version`/`to_version`) to fold in the exact line diff. Waiting on a review? Pass `wait` (seconds, max 50) to long-poll: the call blocks until the human sends back / approves / comments — chain these instead of sleeping. |
| `comment` | Leave feedback, reply (`reply_to` a thread id), anchor to a `quote`, react (`react: "👍"` with `reply_to` — the loop's lightweight ack, landing on the thread's latest human comment), and/or resolve/reopen (`set_state`). |
| `publish` | Save a revision. `content` for a single file, `files` (path→content map) for a multi-page bundle. Omit `short_id` to create new (title required); pass it to add a version. `addresses` lists thread ids this revision resolves; `request_review:true` opens a review round for your human. New artifacts land **private** by default (the human you act for owns the draft) — they promote via the share dialog, so don't pass a wider `visibility` unasked. The result's `opened_in_tab` says whether an open Derive tab caught the push; when false, open the `url` for the user if they should see it now. |

## Role decides: live publish vs proposal

`publish` is one tool. Whether it goes live or files a proposal is decided by **your role** (the scope you were granted), with `for_review:true` to force review:

- **Admin / Creator** → `publish` goes live immediately, or pass `for_review:true` to file a proposal instead.
- **Commenter** → `publish` files a proposal a human approves before it goes live.
- **Viewer** → read-only.

So an agent you authorize with a publish scope publishes exactly as you would; a
lower-scoped agent can still read and publish, but its revisions become proposals a
human approves rather than live content.

## The loop

1. **`catch_up`** → what changed since you last looked, plus the open feedback to address.
2. **`read`** → the content (a page of a bundle, or a past version) in context.
3. **Revise**, then **`comment`** (reply/resolve) and/or **`publish`** (pass `addresses`
   to resolve the threads this revision fixes) — same URL, a new version. Comment
   highlights re-anchor to the moved text.
4. **Review rounds** (the /derive loop): publish with `request_review:true`, then
   chain `catch_up(short_id, wait: 50)` — each call returns the moment the human
   hits Send back / Approve (or ~50s pass). On `sent_back`, sweep ALL threads (any
   author, anchored or not), ack every human comment FIRST
   (`comment(reply_to, react:"👍")` at minimum), then revise and publish with
   `addresses` + `request_review:true` for the next round. The human never
   resolves threads — you settle thread state.

## Keep comments anchorable

Anchors are text quotes with surrounding context, matched in the rendered
document. They survive edits when the text stays recognizable: make local edits,
keep headings and distinctive phrases stable, and prefer real text over images of
text. A comment whose text is gone is shown as "text changed", never moved to the
wrong place.

## Notes

- Versions are immutable; `@vN` URLs never change. The viewer groups rapid
  same-author revisions into time-based sessions, but every revision is addressable.
- Multi-page bundles are readable (`read` with a `section`, `catch_up`) and revisable
  over the remote `/mcp` server via `publish` with a `files` map. Over the stdio
  `@derive-to/mcp` server, bundles are publish-via-remote/web only, and `comment` set_state
  takes a `comment_id`. Both servers expose the same 5 tools.
