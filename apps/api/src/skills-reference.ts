/**
 * The MCP CORE SKILLS — the workflow/protocol prose that used to live inline in every
 * tool description and the server `instructions`, moved out to lazily-read skills so the
 * always-loaded surface stays thin (spec: the "Thin tools, thick skills" plan on Derive). Each skill is served
 * as a resource AND readable via read("derive://skills/<name>"), mirroring exactly how
 * derive://brandprint/* works. A pure leaf: no imports, safe in every build (worker + node).
 *
 * - `publishing` — create + revise artifacts, stage large documents, propose for review.
 * - `assets` — stage image/font bytes and embed the returned URL or ref correctly.
 * - `loop` — catch up on an artifact, respond to feedback, and pull queued work.
 * - `contexts` — use a workspace's live data agents.
 * - `checkpoint` — save working state to a resumable lineage so a later session continues cold.
 * - `organize` — tag + collect artifacts for library findability.
 */

const ASSETS = `# Staging assets in Derive

Use \`stage({ target: "asset" })\` for binary images and web fonts that an artifact
embeds. Staging moves raw bytes from a local file to Derive without putting them through
model context. Staging alone does not create an artifact or a version: stage first, then
reference the result in \`publish\`.

## Supported assets

- Raster images: PNG, JPEG, GIF, and WebP.
- Web fonts: WOFF and WOFF2.
- Maximum size: 25 MB per file.
- Do not stage SVG, HTML, CSS, JavaScript, PDFs, or arbitrary binaries as assets. Keep
  inline SVG/CSS/JS in the page source; use \`stage({ target: "doc" })\` for a large
  document or zip bundle.

## Required workflow

1. Make sure the bytes exist as a local, byte-readable file. A pasted screenshot normally
   already has a local path supplied by the client. Never transcribe or base64-encode it
   into a tool argument. If no byte-capable path exists, ask the user to attach or expose
   the file.
2. Call \`stage({ target: "asset", workspace? })\`. Do not pass \`short_id\`: assets are
   content-addressed, not versioned. The response gives \`upload_url\`, expiry, size limit,
   and accepted MIME types.
3. Treat \`upload_url\` as a short-lived credential. From the shell, POST the file's raw
   bytes with no bearer token:

   \`\`\`bash
   curl -sS -X POST -H "Content-Type: image/png" --data-binary @shot.png "<upload_url>"
   \`\`\`

   Use the matching MIME type for fonts or other image formats. One minted upload URL may
   accept multiple files until it expires; each POST returns its own asset result.
4. Capture the upload response: \`{ key, url, ref, type, size }\`.
   - Use permanent \`url\` in single-file HTML \`<img src>\`, CSS \`url()\`, Markdown
     \`![]()\`, or anywhere a URL is required.
   - Use \`ref\` (the exact \`asset:<hash>\` value) as a binary entry in a bundle's
     \`publish.files\` map, for example \`{ "images/shot.png": "asset:<hash>" }\`, then
     reference \`images/shot.png\` relatively from the bundle's pages.
   - Do not put \`upload_url\` into the artifact. It expires; \`url\` and \`ref\` are the
     durable results.
5. Call \`publish\` with the content or bundle that references the staged asset. For a
   bundle revision, use \`merge:true\` when sending only new asset paths; otherwise a plain
   bundle publish replaces every file.
6. Inspect the result with \`read({ short_id, render: "top", wait: 30 })\` or
   \`render:"full"\`. A successful upload does not prove the path, CSS, font declaration,
   or rendered layout is correct.

## Security and recovery

The returned permanent \`url\` is an unguessable public capability URL: anyone who receives
that exact URL can fetch the bytes independently of the artifact's visibility. Do not
stage a sensitive asset unless that sharing model is acceptable.

If the upload URL expired, call \`stage\` again and retry the raw-byte upload. If staging is
denied, do not improvise a base64 fallback: the actor needs publish permission, the target
workspace must be correct, and a self-hosted server needs its signing secret configured.
`

const PUBLISHING = `# Publishing to Derive

How to WRITE to Derive: create and revise artifacts with \`publish\`, and stage large
content or binary assets with \`stage\` (target:'doc' for a whole big document/bundle,
target:'asset' for an image/font). Derive hosts living documents and plans with versioned
history; a fully-styled HTML page is a first-class artifact that renders as-authored in a
sandboxed viewer, so publish real designed pages, not just prose.

## Key rules (read these first)

- NEVER base64 a binary through a tool call. Every image/font: stage target:'asset' -> curl the raw bytes -> paste the returned url (or its asset:<hash> ref). A pasted image is already a file on disk; upload that file, don't transcribe it. publish REJECTS a single inline data: URI past ~32KB (stage the asset) and any inline content/files summing past ~64KB (stage target:'doc').
- Assets are raster images and web fonts ONLY: PNG/JPEG/GIF/WebP/WOFF/WOFF2, <=25MB each. Inline SVG, CSS, and JS in the page itself (SVG is rejected as an asset).
- Anything bigger than ~a page: stage target:'doc' (curl the file/zip), never inline content/files.
- On a styled HTML page, declare your own <meta name="viewport">, or it gets a mobile-reflow injection that can fight your layout (data-reflow-exempt is the per-element escape hatch).
- After publishing a styled page, read with render:"top" (or "full") to SEE it before you trust it; a text read can't catch a failed font or a broken layout.
- To change part of a doc, read format:'html' FIRST, then edits with base_version. A bad match applies NOTHING and tells you why; fix and retry.
- Republishing a bundle REPLACES it: include every page and asset, or use merge to add only the new files.
- Verify content_sha256 in the response whenever the content passed through your context.

## publish: edits vs content vs files

\`publish\` saves a revision of an artifact.

- **Create vs revise.** OMIT \`short_id\` to create a NEW artifact (\`title\` required); PASS
  \`short_id\` to add a version to one you own, matching its kind. Kind can't change on
  republish — a bundle stays a bundle, a single file stays a single file.
- **Surgical edits (preferred for partial changes).** To change PART of a single-file
  artifact, prefer \`edits\` — exact-match search/replace against the stored source — over
  resending everything. Read \`format:'html'\` FIRST on an HTML artifact: edits match the
  raw stored source, and the markdown reading view will not match. Each edit is
  \`{ old_str, new_str, occurrence? }\`, applied in order (each edit sees the previous
  one's result). \`old_str\` must occur exactly once, unless \`occurrence\` (a 1-based index)
  picks one of several. \`new_str\` empty deletes. The batch errors — applying NOTHING — if
  any \`old_str\` matches zero times, or matches more than once without \`occurrence\`; the
  error explains why (a whitespace difference, or the doc changed) so you can fix it in
  one round. Requires \`short_id\`; use INSTEAD of \`content\`. Composes with \`for_review\`,
  \`addresses\`, \`message\`, \`request_review\`.
- **base_version safety.** With \`edits\`, pass the version you read as \`base_version\`; the
  publish errors instead of applying when the artifact has moved past it.
- **Full single file.** Provide the complete \`content\` (HTML or Markdown) for a
  single-file artifact.
- **Bundle.** Provide \`files\` (a map of page path → content) for a MULTI-PAGE bundle — a
  whole site, images and any binary asset. The root \`index.html\` (else the shallowest
  \`.html\`) becomes the entry page; pages reference assets by relative path. Served
  content-type comes from the file extension, so give binary entries a real extension
  (.png/.jpg/.webp/.woff2). Each published page is also readable directly at
  \`/raw/<short_id>/v/<n>/<path>\` once live.

## Bundles: merge and spa

- A plain bundle republish REPLACES the whole bundle, so include EVERY page and asset — or
  use \`merge\`.
- **merge**: add/overwrite the given \`files\` INTO the existing bundle instead of replacing
  it (default false). Build a large site across several calls without re-sending it:
  publish the pages first, then merge in batches of assets — each call carries only the new
  files. Requires the \`short_id\` of a bundle; same-path files overwrite, the rest are kept.
- **spa** (a NEW bundle only): serve unknown paths from the entry page (single-page-app
  routing). Default false.

## Assets

Images and web fonts use a separate byte-safe workflow. Read
\`derive://skills/assets\` before staging or embedding them. The short version is:
\`stage({target:"asset"})\` → POST the local file's raw bytes to \`upload_url\` → use the
upload response's permanent \`url\` in single-file content or its \`ref\` in a bundle
\`files\` map → \`publish\` → inspect the rendered artifact. Staging alone does not publish
an artifact.

## Fully-styled HTML

A single-file artifact with its own \`<style>\`, scripts, fonts and images renders
as-authored in the sandboxed viewer (note: the \`read\` tool FLATTENS HTML to text — that
reading view is not what a viewer sees). Two rules:

- Declare your own \`<meta name="viewport">\`. Pages without one get a mobile-reflow
  injection whose media caps can fight intentional layouts; \`data-reflow-exempt\` on an
  element is the per-component escape hatch.
- Self-host binaries via a stage target:'asset' upload URL (images AND woff2 fonts) instead
  of base64.

After publishing a styled page, call \`read\` with \`render:"top"\` (or \`"full"\`/\`"marked"\`)
to SEE what shipped — a screenshot of the served page catches visual breakage (a failed
font, a broken layout) that no text read can. The screenshots are computed a few seconds
after each publish.

## stage target:'doc' for large docs and bundles

Inline \`content\`/\`files\` is model output — capped by the per-response token ceiling and
forced into slow, costly multi-turn chunking once a file is bigger than a page or two (and
publish REJECTS an inline payload past ~64KB). For a document too large to inline (a big
designed HTML page or a multi-file bundle), call \`stage\` with target:'doc' and curl the
file/zip to the returned URL instead of chunking it through content/files — zero bytes
through the model's context.

Omit \`short_id\` to CREATE a new artifact; pass a \`short_id\` to REVISE that one (the token is
scoped to exactly that target). Then from your shell: a single file → \`curl -sS -F
file=@page.html -F title='My Page' <upload_url>\`; a bundle → zip the dir first (\`cd site &&
zip -r /tmp/site.zip .\`) then \`curl -sS -F file=@/tmp/site.zip <upload_url>\` (a .zip
publishes as a multi-page bundle). The URL is reusable until it expires (~15 min). Prefer
the plain publish tool for small docs and for surgical \`edits\`; reach for stage target:'doc'
only when inlining would chunk.

## content_sha256 verification

A single-file publish's response echoes \`content_sha256\` of the stored bytes (the
content-addressed blob key) — verify it when the content passed through your context, so
you know what landed matches what you sent.

## Proposals and review (the /derive loop)

\`publish\` goes LIVE immediately if your role can publish (Creator/Admin); otherwise — or
whenever you pass \`for_review:true\` — it is filed as a PROPOSAL a human approves before it
goes live. (Proposals are single-file only; bundles must be published directly.)

- **addresses**: pass the thread ids (from catch_up) this revision resolves. On a live
  publish they resolve; on a proposal they flip to \`addressed\` and resolve on approval.
- **request_review**: after a LIVE publish, open a review round asking your human to review
  this version — the /derive loop. They answer inline and hit Send back (or Approve); poll
  catch_up's \`review\` field for the state. No effect on a proposal (that already IS a
  review).

## Access on a NEW artifact

Access is set on create; a republish never re-stamps it. The factory default is the "team
draft" — \`workspace_access=member\`, \`link_role=none\`, \`listed=none\`: a teammate can open
the pasted link, the world can't, and it stays out of feeds until a human promotes it.
Sharing wider (\`workspace_access\`, \`link_role\`, \`listed\`) stays a deliberate act — see
those params' own descriptions for the exact meanings.
`

const LOOP = `# The Derive working loop

Start a session with \`catch_up\`, respond to feedback with \`comment\`, and pull queued work
with \`catch_up\` (no short_id). This is the read → respond → revise (revise via publish) rhythm around a Derive artifact.

## catch_up: state, feedback, history, diffs

START HERE on an artifact (pass its \`short_id\`). Its state in one call: a one-line summary, the versions that
landed since \`since_version\`, which pages changed, the open (and outdated) comment threads,
the review round you're waiting on, and the full version history.

- **Feedback queue.** Pass \`comments\` (open / addressed / resolved / outdated) to instead
  get that filtered thread list — your feedback to-do queue. \`outdated\` means the quoted
  text changed in a landed version, so the feedback may no longer apply; \`addressed\` means a
  proposal is already pending for it (don't re-address).
- **Diffs.** Pass \`response_format='detailed'\` (optionally with \`since_version\`/\`to_version\`)
  to include a line-by-line diff between two versions — of their READABLE Markdown form,
  not raw HTML, so it shows what changed rather than tag noise. \`since_version\` defaults to
  \`to_version − 1\`.
- **Review state.** The \`review\` field tracks the round this agent is waiting on:
  \`pending\` = still waiting for the human; \`sent_back\` = the human returned answers, read
  the open threads and revise; \`approved\` = the go-signal to proceed. (A round is opened or re-opened with publish's \`request_review\` — see the publishing skill.)
- **Wait (long-poll).** WAITING ON SOMETHING? Pass \`wait\` (seconds, max 50): the call blocks
  until the human sends back / approves / comments / publishes a new version (or the time
  runs out), then returns the fresh state — including anything new since \`since_version\`.
  Works with no pending review too: co-editing live with a human, \`wait\` blocks until THEIR
  next save lands. Chain \`wait\` calls instead of sleeping between polls — feedback reaches
  you in seconds.

## comment: leave, reply, react, resolve

Leave feedback on an artifact, reply in a thread, react, and/or resolve or reopen a thread
— all in one tool. Thread ids come from catch_up.

- **New comment.** Anchor it to a quoted span of the rendered text with \`quote\` (the exact
  text a reader sees — the same visible text the \`text\` read format shows).
- **Reply.** Pass the thread id as \`reply_to\`.
- **React (the lightweight ack).** Pass \`react\` (with \`reply_to\`) to acknowledge the latest
  human comment in a thread without the noise of a reply — the minimum ack the loop
  requires. 👍 is the conventional ack; pass it explicitly.
- **Resolve / reopen.** Pass \`set_state\` (\`resolved\` or \`open\`) along with the thread's id
  in \`reply_to\`.

## catch_up (no short_id): your work queue

Call \`catch_up\` with NO short_id for your work queue: pending requests teammates handed you
by @mentioning you in a comment (the ask-agent and Rework buttons land here). Each entry
names the artifact, the comment thread, and what to do. (A connection with no @mentionable
inbox — an OAuth grant — gets an explicit note instead of a queue.)

- **Handle then ack.** Work a request on its artifact — usually read it, do the asked
  revision, and publish with the thread id in \`addresses\` — then call catch_up (no short_id)
  again with \`ack:[id,…]\` to clear what you finished. Ack AFTER the work lands (a publish or
  a reply), not on read; an unknown or already-acked id is skipped, never an error. Unacked
  requests stay queued for your next session.
- **Wait (long-poll).** WAITING FOR WORK? Pass \`wait\` (seconds, max 50): when the queue is
  empty the call blocks until a new request lands (or the time runs out), then returns it —
  chain \`wait\` calls to react in seconds instead of polling on a cadence.

## Review-round etiquette

When the human sends a review back (\`review.state === 'sent_back'\` in catch_up), sweep the
open threads and acknowledge each as you address it — a \`react\` is the minimum the loop
requires (👍 by default), or a reply where a threaded answer helps. Then revise and
re-request review (publish with \`request_review:true\`). Cite the threads a revision fixes as publish's \`addresses\` on the SAME
publish that resolves them, so they resolve (on a live publish) or flip to \`addressed\` (on a
proposal) rather than being closed in a separate step.
`

const CONTEXTS = `# Using workspace contexts

Workspaces can host CONTEXTS — askable live data agents a workspace owner wired up, each
answering questions against its own data and tools. \`find\` surfaces the ones your user may
use (as typed context rows in browse/search); \`use\` opens a session on your user's behalf —
a question or a commission — and returns the answer.

## Discovering contexts with find

\`find\` (browse, or a query whose text matches a context name) lists the contexts you may
use in a workspace — id, name, whether the runner is online (its last queue poll is recent),
the manifest doc that defines it, and your own still-open sessions so you can resume one with
\`use\`. Using happens on your user's behalf and is granted per context, so what \`find\`
surfaces is EXACTLY what your user may use, nothing more. Then call \`use\` with a context's id
or name.

## use: open, follow up, or check

Use a context on your user's behalf, or resume/follow up an existing session:

- **OPEN** a new session: pass \`context\` (id or name) + \`question\`.
- **FOLLOW UP** an existing session: pass \`session_id\` + \`question\` (it already knows its
  context, so don't also pass \`context\`).
- **CHECK / RESUME**: pass \`session_id\` alone (no question) to read the latest state and
  transcript.

The call waits up to \`wait\` seconds (default 25, max 50; 0 = return at once) for the runner's
answer and returns it inline when it lands. Real runs often take MINUTES, so a still-open
response is NORMAL, not an error: an expired wait leaves the session open — re-call \`use\`
with the returned \`session_id\` (+ \`wait\`) until it settles. Sessions resume across calls
and across your own sessions; a context row in \`find\` surfaces your still-open ones. If the
runner looks offline, the session is queued and answers when it comes back. Answers cite
artifact short_ids you can then \`read\`.

A settled session is normally \`answered\`; it can instead come back \`escalated\` (the runner handed a draft to a human reviewer, check back later) or \`failed\` (the run crashed, just ask again). Re-calling \`use\` always returns the current \`state\` and a one-line \`note\`.
`

const CHECKPOINT = `# Checkpointing working state

Commit a compact, resumable snapshot of your working state so any later session (on any machine) continues cold.

- **First call for a piece of work:** pass \`work\` (a short name); the lineage is created and
  the result names its \`short_id\` — record it (e.g. in a \`.derive/lineage\` file at the repo
  root) and pass it as \`short_id\` on every checkpoint after.
- **Each checkpoint REPLACES the page** (versions keep the history; each layer is a pinned
  named version), so restate what still matters and drop what doesn't — the tool rejects
  more than a page.
- **Prefer refs over restated detail.** Cite artifact short_ids, PR/issue URLs, and key file
  paths in \`refs\`: the layer is an index a cold session follows, not a container. A
  continuing session reads those refs (artifact short_ids via the \`read\` tool) to rehydrate.
`

const ORGANIZE = `# Organizing the library (tags + collections)

\`organize\` is the library's findability layer: browse TAGS (lightweight labels) and
COLLECTIONS (a set treated as a unit), in one tool. Tag freely and reuse the vocabulary — a
well-tagged library is findable. Reach for a collection only when a set is a real unit, not
for plain findability. Tags can also be set at publish time via publish's \`tags\` param.

## Read mode

- **No \`short_ids\`:** returns the workspace's tag vocabulary (tag → count) and its
  collections. Call this BEFORE tagging so you reuse an existing tag over a near-duplicate.
- **With \`short_ids\`:** returns those artifacts' current tags + collections, plus
  \`suggested\` tags drawn from the most semantically-similar docs (when a single id is given).

## Write mode (pass \`short_ids\` plus any of these)

- **\`add\`** — union onto existing tags (never drops what's there).
- **\`remove\`** — drop these tags.
- **\`set\`** — replace the whole tag set (overrides add/remove).
- **\`collection\`** — fold the artifacts into a collection, by id or by name (created if new).

Tags are normalized (trimmed, lowercased, deduped, capped 20). Each artifact is authorized on
its own; ones you can't edit come back as \`skipped\`, never failing the batch.
`

export const CORE_SKILLS: readonly { name: string; summary: string; body: string }[] = [
  {
    name: "loop",
    summary:
      "catch up on an artifact, work a review round, respond to feedback, and pull queued work (catch_up, comment)",
    body: LOOP,
  },
  {
    name: "publishing",
    summary:
      "create and revise artifacts (incl. fully-styled HTML pages), stage large documents, and file proposals for review (publish, stage)",
    body: PUBLISHING,
  },
  {
    name: "assets",
    summary:
      "stage image/font bytes, choose the permanent URL or bundle ref, publish the reference, and verify the render (stage, publish, read)",
    body: ASSETS,
  },
  {
    name: "contexts",
    summary: "use a workspace's live data agents (find, use)",
    body: CONTEXTS,
  },
  {
    name: "checkpoint",
    summary:
      "save your working state to a resumable lineage so a later session continues cold, on any machine (checkpoint)",
    body: CHECKPOINT,
  },
  {
    name: "organize",
    summary:
      "make the library findable: browse the tag vocabulary + collections, and tag or collect artifacts (organize)",
    body: ORGANIZE,
  },
]
