# dock-comments

The comment system is the feedback loop. Comments are anchored to exact text passages
and survive rewrites as long as the text stays recognizable.

---

## Data model

```
comment
  id           string   unique id (c_...)
  thread_id    string   groups replies; equals id for root comments
  base_version int      which artifact version was current when posted
  anchor       JSON     TextQuoteSelector (see below) — null for general comments
  body_md      string   Markdown comment text
  author       string   display name
  state        string   "open" or "resolved"
```

All replies in a thread share the same `thread_id`. The root comment IS the thread.

---

## Text anchors (TextQuoteSelector)

```json
{
  "type": "TextQuoteSelector",
  "exact": "the exact quoted text",
  "prefix": "up to 24 chars before",
  "suffix": "up to 24 chars after"
}
```

The anchor re-matches on each render using `exact` + surrounding context. It survives
edits when the quoted text stays recognizable. If the exact text is deleted, the comment
shows "text changed" — it never attaches to the wrong place.

On a **slide deck**, the anchor also carries `"slide": N` (0-based) — the slide the comment
was made on. Dock resolves the quote within that slide first, so the same phrase on two
slides doesn't collide, and pins the comment to that slide. If the text later moves to a
different slide, the comment follows it and is flagged "moved". See `formats/dock-deck.md`.

---

## Listing comments

```
list_comments(short_id, state?)
```

`state` is `"open"` or `"resolved"`. Omit to get all threads.

Each comment includes: `id`, `thread_id`, `base_version`, `state`, `author`, `body_md`,
`anchor` (the TextQuoteSelector JSON or null), `created_at`, and `anchored` (boolean —
whether the anchor still resolves in the current version).

---

## Adding a comment

```
add_comment(short_id, body_md, quote?)
```

Pass `quote` as the exact text you want to anchor to. Dock finds it in the current version
and builds the TextQuoteSelector automatically. Omit `quote` for a general (unanchored) comment.

```
# General feedback
add_comment("nk0dsral", "The conclusion needs a call to action.")

# Anchored to a specific passage
add_comment("nk0dsral", "This sentence is unclear.", "The system resolves ambiguities")
```

---

## Replying

```
reply_comment(short_id, thread_id, body_md)
```

Use the `thread_id` from the root comment (or any comment in the thread — they all share it).
Replies don't need an anchor; they're part of the root comment's thread.

---

## Resolving threads

```
resolve_thread(short_id, comment_id, state?)
```

`state` defaults to `"resolved"`. Pass `state: "open"` to reopen a closed thread.
`comment_id` can be any comment in the thread — Dock resolves the thread it belongs to.

The most efficient pattern is to resolve threads at the same time as publishing a new version:

```
publish_version("nk0dsral", newContent, "report.html", "Fixed intro", ["c_abc123", "c_def456"])
```

---

## Reactions

Comments support 8 fixed emoji reactions: 👍 ❤️ 🎉 😄 👀 🙏 🚀 👎

Reactions are stored in `comment.meta.reactions` as `{ emoji: [authorName, ...] }`.
Tapping the same emoji twice removes your name (toggle behavior).

Reactions are not exposed in the MCP tools — use the Dock UI to react.

---

## Mentions

Include `@agent-name` in `body_md` to mention an agent. Mentions for agents land in their
pull inbox (`agentMention` table) — not in a user notification bell. The agent can poll its
inbox or be pinged via the SSE stream (`comment.mention` event).

Human user mentions (`@user`) send an in-app notification to that user.

---

## What "text changed" means

When a comment's anchor shows "text changed", it means the `exact` text from the
TextQuoteSelector no longer appears anywhere in the current version. The comment is still
visible and resolvable — it just can't be scrolled to or highlighted because the passage
it referenced is gone.
