---
name: derive
description: Use Derive to publish or revise artifacts, stage and embed image or font assets, request and act on inline review, comment, find workspace docs, organize work, checkpoint state, or query workspace contexts. Trigger when the user says Derive or /derive; asks to publish, share, review, or ship a plan, page, doc, site, deck, screenshot, image, or other asset; or asks to check and address Derive feedback. Requires the Derive MCP; skip for ordinary local-only edits unless the user wants the result in Derive.
---

# Work with Derive

Use Derive as the shared surface between the agent and its human: publish a living
artifact, collect feedback on the rendered result, revise the same URL, and close the
loop. Prefer the remote Derive MCP at `https://derive.to/mcp`; it is the complete and
current tool surface.

## Start here

1. Confirm Derive tools are connected. The current remote surface has `find`, `read`,
   `catch_up`, `comment`, `stage`, `publish`, `organize`, `checkpoint`, `use`, and
   `list_workspaces`.
2. If the tools are missing, follow [references/connect.md](references/connect.md). Do
   not invent a token, publish through raw HTTP, or ask the user to paste credentials.
3. Before a non-trivial operation, load the matching MCP skill below. Prefer the MCP
   resource; if the client does not expose resources, call Derive's `read` tool with the
   URI as `short_id`.

| Intent | Read first | Main tools |
|---|---|---|
| Create, revise, upload a large doc, or propose | `derive://skills/publishing` | `publish`, `stage`, `read` |
| Upload or embed an image/font asset | `derive://skills/assets` | `stage`, `publish`, `read` |
| Review, feedback, requests, or waiting | `derive://skills/loop` | `catch_up`, `read`, `comment`, `publish` |
| Query a live workspace data agent | `derive://skills/contexts` | `find`, `use` |
| Save resumable working state | `derive://skills/checkpoint` | `checkpoint` |
| Tag or collect library work | `derive://skills/organize` | `organize`, `find` |

Workspace-specific procedures may also be published as skills. Discover them with
`find({skills:true})`, then `read` the relevant one before acting.

## Default working loop

For an existing artifact:

1. Call `catch_up` first. Read the review state, every actionable thread, and versions
   since the last known version.
2. Call `read` for only the sections needed. For HTML edits, read the exact source with
   `format:"html"`.
3. Acknowledge each human comment. A 👍 reaction is the minimum; reply when the answer
   belongs in the thread.
4. Revise with `publish`. Prefer exact `edits` plus `base_version` for a partial change;
   include thread ids in `addresses` on the same publish.
5. If review is wanted, set `request_review:true`, then chain
   `catch_up({short_id, wait:50})` while the round is pending. On `sent_back`, sweep all
   threads and repeat. `approved` is the go-signal.

For a new artifact, publish it as the workspace's default team draft unless the user
explicitly asks for wider access. Return the artifact URL, version, review state, and a
short account of what changed.

## Non-negotiable rules

- Do not widen access or listing without the user's explicit request.
- Never put image or font bytes through model context. Read `derive://skills/assets`,
  call `stage({target:"asset"})`, POST the local file's raw bytes to `upload_url`, then
  use the upload response's permanent `url` in single-file content or its `ref` as a
  bundle `files` value. Staging alone does not publish an artifact.
- Use `stage({target:"doc"})` for a large document or zip bundle instead of chunking it
  through tool arguments.
- A bundle replacement must contain every file; use `merge` when adding only part.
- After publishing styled HTML, inspect it with `read({render:"top"})` or `"full"`.
- Keep anchors stable with focused edits. Do not silently drop a human thread, and do
  not expect the human to resolve agent-addressed feedback.
- If multiple workspaces are reachable and the destination is unclear, call
  `list_workspaces` and use the workspace descriptions. Ask only when the evidence does
  not identify the intended destination.
- Derive hosts documents, pages, and versioned artifacts — not compute. Do not use it
  for server-side code execution, general-purpose data storage, secrets, or as an app
  backend; publish the artifact and keep the system elsewhere.
- If this file and the live server disagree about a tool, parameter, or behavior, trust
  the live server: installed copies of this file go stale. The server's tool
  descriptions and `derive://skills/*` resources are current; re-read them before
  answering capability questions.

## Compatibility surface

The local stdio compatibility server exposes `list_workspaces`, `list_artifacts`,
`search`, `read`, `catch_up`, `comment`, `organize`, and `publish`. It supports the
basic loop, library organization, and per-call workspace routing, but lacks the remote
server's staging, contexts, and checkpoint capabilities. Read
[references/compatibility.md](references/compatibility.md) before using that surface.
