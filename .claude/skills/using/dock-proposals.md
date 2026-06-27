# dock-proposals

The propose -> review -> approve loop. Proposals let agents contribute revisions that
don't go live until a human approves them.

---

## When to use proposals

An agent with **commenter role** (the default) cannot publish directly. It must propose.
A human (or agent with editor role) then reviews and approves or requests changes.

An agent with **editor role** can publish directly via `publish`, no proposal needed.

Use proposals when:
- You want a human checkpoint before content goes live
- The agent is operating as a contributor, not a publisher
- You want a preview URL to share with reviewers before committing

---

## Proposal states

```
open -> approved (new version published, artifact updated)
     -> changes_requested (reviewer asks for a revision)
     -> withdrawn (proposer or manager cancelled it)
```

Each proposal is a separate entity — "requesting changes" doesn't modify the proposal,
it just flags it. The agent creates a new proposal for each revision.

---

## Proposing via MCP

There is one publishing tool, `publish`. Whether it goes live or files a proposal is
decided by your role: an editor (Creator/Admin) role publishes directly, while a commenter
role files a proposal. Pass `for_review:true` to file a proposal even when your role could
publish directly.

To propose via REST instead:

```bash
curl -X POST https://dock.build/v1/artifacts/<short_id>/proposals \
  -H "Authorization: Bearer $DOCK_TOKEN" \
  -F "file=@revised.html" \
  -F "message=Tightened the intro and fixed the table"
```

Response includes a `preview_url` — share it with the reviewer so they can read the
proposed version before approving.

---

## Reviewing a proposal

```bash
# List open proposals
GET /v1/artifacts/<short_id>/proposals?state=open

# See the diff
GET /v1/artifacts/<short_id>/proposals/<proposalId>
# Returns: base_version, state, author, message, diff ops (add/del/ctx)

# Approve (goes live as a new version)
POST /v1/artifacts/<short_id>/proposals/<proposalId>/approve
{ "note": "Looks good, approved." }

# Request changes (keeps proposal open, notifies proposer)
POST /v1/artifacts/<short_id>/proposals/<proposalId>/request-changes
{ "note": "Please shorten the third paragraph." }

# Withdraw (proposer or manager only)
POST /v1/artifacts/<short_id>/proposals/<proposalId>/withdraw
```

---

## Addressing threads in a proposal

When you propose a revision that addresses open comment threads, include the thread IDs
in the `addresses` field. Once the proposal is approved, those threads auto-resolve.

```bash
curl -X POST https://dock.build/v1/artifacts/<short_id>/proposals \
  -H "Authorization: Bearer $DOCK_TOKEN" \
  -F "file=@revised.html" \
  -F "message=Fixed the intro" \
  -F "addresses=t_abc123,t_def456"
```

---

## The OAuth MCP server

The OAuth-based remote `/mcp` server (used when connecting via browser consent rather than a
static token) exposes the same 5 tools, including `publish`. The OAuth scope you grant maps
to a role: a commenter-scoped agent's `publish` calls always file a proposal a human approves
in the UI, while a publish-scoped agent goes live (and can still pass `for_review:true` to
file a proposal).
