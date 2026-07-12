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
| `read` | Read an artifact's content by short id, as **Markdown by default** (HTML is converted — headings, lists, tables, code fences; a styled page still renders fully to viewers, only this reading view flattens it). Omit `section` and a small doc/bundle returns whole; a **large one returns its outline first** (heading slugs for a single-file doc, page paths for a bundle) — call again with a `section` (a slug, a bundle page, `page.html#slug`, or `"*"` for the full clipped document). Pass `format:'html'` for the exact stored source (needed before publish `edits`) or `format:'text'` for flat visible text (what comment `quote`s anchor against). Pass `version` to read history. An image page in a bundle comes back as a real image, not garbage text. |
| `catch_up` | Start here on an artifact: its state in one call — what changed since `since_version`, the open/outdated comment threads, the `review` round state, and version history. Pass `comments` (open/addressed/resolved/outdated) for that filtered feedback queue, or `response_format='detailed'` (with optional `since_version`/`to_version`) to fold in a line diff — of the **readable Markdown form**, not raw HTML, so it shows what changed instead of tag noise. Waiting on a review? Pass `wait` (seconds, max 50) to long-poll: the call blocks until the human sends back / approves / comments — chain these instead of sleeping. |
| `comment` | Leave feedback, reply (`reply_to` a thread id), anchor to a `quote`, react (`react: "👍"` with `reply_to` — the loop's lightweight ack, landing on the thread's latest human comment), and/or resolve/reopen (`set_state`). |
| `publish` | Save a revision. `content` for a single file, `files` (path→content map) for a multi-page bundle, or **`edits`** (`[{old_str, new_str}]`) to revise part of a single-file artifact without resending it. Omit `short_id` to create new (title required); pass it to add a version. `addresses` lists thread ids this revision resolves; `request_review:true` opens a review round for your human. New artifacts land **private** by default (the human you act for owns the draft) — they promote via the share dialog, so don't pass a wider `visibility` unasked. The result's `opened_in_tab` says whether an open Derive tab caught the push; when false, open the `url` for the user if they should see it now. Fully-styled HTML renders as-authored in the sandboxed viewer: declare your own `<meta name="viewport">` (skips the mobile-reflow injection; `data-reflow-exempt` exempts a single element), upload images/woff2 fonts to `POST /v1/assets` instead of inlining base64, and check the echoed `content_sha256` against your local bytes. |

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

## Reading big documents

`read` never hands you a wall of JSON-escaped HTML. A content-bearing response is
a small frontmatter header (short id, title, version, format, section, size, url)
followed by a blank line and the raw body — real newlines, greppable if a client
spills it to a file. When a document is large, `read` (no `section`) returns its
heading outline instead of the full text:

```
{ "sections": [
    { "slug": "why-one-engine", "level": 2, "text": "Why: one engine", "chars": 2210 },
    { "slug": "pr-6-the-fix",   "level": 2, "text": "PR-6: the fix",   "chars": 4812 }
  ], "next": "Call read again with a section slug…" }
```

Pull just the part you need: `read(short_id, { section: "pr-6-the-fix" })`. Pass
`section: "*"` to force the full (clipped) document when you genuinely need it all.

## Edit, don't resend

Once you've read a section, revise it with `publish`'s `edits` instead of
resending the whole artifact:

```
publish(short_id, { edits: [{ old_str: "exact text from the source", new_str: "replacement" }] })
```

Each `old_str` must match **exactly once** in the current stored source — the
same contract as a coding Edit tool. If it doesn't match (or matches more than
once), nothing is applied and the error names which edit failed, so you add more
surrounding context and retry. For an HTML artifact, read with `format:'html'`
first — the Markdown view won't match raw source. Pass `base_version` (the
version you read) to fail fast instead of silently editing a version you never saw.

## Mockups & screens

Reading Markdown by default doesn't flatten design work:

- **See it rendered**: every `read` response's frontmatter carries the artifact's
  `url` — open it in a real browser (or a browser-automation tool) to view or
  screenshot the live page.
- **See its structure/copy**: the default Markdown read.
- **See a screenshot inline**: reading an image page of a bundle (`section:
  "shot.png"`) returns a real image content block, not decoded bytes as text.
- **Edit it**: `read(section, format:'html')` for the exact markup, then
  `publish({ edits })` for a surgical change — a label, a color token — without
  resending the whole design.

## Keep comments anchorable

Anchors are text quotes with surrounding context, matched in the rendered
document. They survive edits when the text stays recognizable: make local edits,
keep headings and distinctive phrases stable, and prefer real text over images of
text. A comment whose text is gone is shown as "text changed", never moved to the
wrong place.

## Notes

- Versions are immutable; `@vN` URLs never change. The viewer groups rapid
  same-author revisions into time-based sessions, but every revision is addressable.
- Multi-page bundles are readable on both servers (`read` with a `section` — a page
  path, or `page.html#slug` for one heading's part; `catch_up`) but revisable only
  over the remote `/mcp` server via `publish` with a `files` map. Over the stdio
  `@derive-to/mcp` server, bundles are publish-via-remote/web only, and `comment`
  set_state takes a `comment_id`. `edits` (single-file only) works on both. Both
  servers expose the same 5 tools.
- An older self-hosted Derive server that predates `format`/`section`/`outline`
  responds to `read` with a note that it returned the full raw artifact instead —
  the stdio client detects this from a missing response header and degrades rather
  than silently misreading a section.
- The stdio server shares the machine's `derive login` — no token to paste. It acts as
  your stored default account/workspace unless `DERIVE_ACCOUNT`/`DERIVE_WORKSPACE`
  pin the project to a specific one (id or name; set in `.mcp.json`'s `env`). Still no
  `whoami` tool, but a wrong pin fails loudly at startup rather than silently
  targeting the wrong workspace.
