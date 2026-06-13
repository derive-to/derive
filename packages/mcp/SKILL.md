# Dock — agent skill

Dock hosts an artifact (HTML, Markdown, or a static bundle) at a permanent,
versioned URL with inline comments. You drive the **publish → review → revise**
loop through these MCP tools. Also readable as the `dock://guide` resource.

## Tools

| Tool | Use |
|---|---|
| `publish_artifact` | Publish new content; returns a `short_id` + URL. |
| `publish_version` | New version of an existing artifact (same URL). `resolves: [ids]` closes threads in the same step. |
| `get_artifact` | Read metadata + source for a version (defaults to current). |
| `list_versions` | Version history. |
| `diff_versions` | What changed between two versions (defaults previous → current). |
| `restore_version` | Make a past version current again (history is preserved). |
| `list_comments` | The feedback queue; filter by `open` / `resolved`. |
| `add_comment` | Leave new feedback; optionally `quote` exact text to anchor it. |
| `reply_comment` | Reply in an existing thread (`thread_id`). |
| `resolve_thread` | Resolve (or reopen) the thread a comment belongs to. |
| `view_stats` | View analytics (total, unique, per-version). |

## The loop

1. **Publish** a draft with `publish_artifact`. Keep the `short_id`.
2. **Read** feedback with `list_comments` (state `open`). Each comment has a
   quoted anchor, a thread, and a base version.
3. **Understand** a comment in context: `get_artifact` for the source, or
   `diff_versions` to see what changed since it was written.
4. **Revise** the source and `publish_version` — the same URL, a new version.
   Comment highlights re-anchor to the moved text automatically. Pass
   `resolves: [commentId]` to close the threads you addressed in one call.
5. **Reply** with `reply_comment` to discuss, or `resolve_thread` to close a
   thread once handled. Leave your own review with `add_comment` (+ `quote`).

## Keep comments anchorable

Anchors are text quotes with surrounding context, matched in the rendered
document. They survive edits when the text stays recognizable: make local edits,
keep headings and distinctive phrases stable, and prefer real text over images
of text. A comment whose text is gone is shown as "text changed", never moved to
the wrong place.

## Notes

- Versions are immutable; `@vN` URLs never change. The viewer groups rapid
  same-author revisions into time-based sessions, but every revision is addressable.
- Set `DOCK_SERVER` (and `DOCK_TOKEN` if the instance is gated) for the tools to
  reach your Dock server.
