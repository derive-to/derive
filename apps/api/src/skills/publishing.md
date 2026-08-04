---
name: publishing
summary: create and revise artifacts (incl. fully-styled HTML pages), stage large documents, and file proposals for review (publish, stage)
order: 3
---
# Publishing to Derive

How to WRITE to Derive: create and revise artifacts with `publish`, and stage large
content or binary assets with `stage` (target:'doc' for a whole big document/bundle,
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

`publish` saves a revision of an artifact.

- **Create vs revise.** OMIT `short_id` to create a NEW artifact (`title` required); PASS
  `short_id` to add a version to one you own, matching its kind. Kind can't change on
  republish — a bundle stays a bundle, a single file stays a single file.
- **Surgical edits (preferred for partial changes).** To change PART of a single-file
  artifact, prefer `edits` — exact-match search/replace against the stored source — over
  resending everything. Read `format:'html'` FIRST on an HTML artifact: edits match the
  raw stored source, and the markdown reading view will not match. Each edit is
  `{ old_str, new_str, occurrence? }`, applied in order (each edit sees the previous
  one's result). `old_str` must occur exactly once, unless `occurrence` (a 1-based index)
  picks one of several. `new_str` empty deletes. The batch errors — applying NOTHING — if
  any `old_str` matches zero times, or matches more than once without `occurrence`; the
  error explains why (a whitespace difference, or the doc changed) so you can fix it in
  one round. Requires `short_id`; use INSTEAD of `content`. Composes with `for_review`,
  `addresses`, `message`, `request_review`.
- **base_version safety.** With `edits`, pass the version you read as `base_version`; the
  publish errors instead of applying when the artifact has moved past it.
- **Full single file.** Provide the complete `content` (HTML or Markdown) for a
  single-file artifact.
- **Bundle.** Provide `files` (a map of page path → content) for a MULTI-PAGE bundle — a
  whole site, images and any binary asset. The root `index.html` (else the shallowest
  `.html`) becomes the entry page; pages reference assets by relative path. Served
  content-type comes from the file extension, so give binary entries a real extension
  (.png/.jpg/.webp/.woff2). Each published page is also readable directly at
  `/raw/<short_id>/v/<n>/<path>` once live.

## Bundles: merge and spa

- A plain bundle republish REPLACES the whole bundle, so include EVERY page and asset — or
  use `merge`.
- **merge**: add/overwrite the given `files` INTO the existing bundle instead of replacing
  it (default false). Build a large site across several calls without re-sending it:
  publish the pages first, then merge in batches of assets — each call carries only the new
  files. Requires the `short_id` of a bundle; same-path files overwrite, the rest are kept.
- **spa** (a NEW bundle only): serve unknown paths from the entry page (single-page-app
  routing). Default false.

## Assets

Images and web fonts use a separate byte-safe workflow. Read
`derive://skills/assets` before staging or embedding them. The short version is:
`stage({target:"asset"})` → POST the local file's raw bytes to `upload_url` → use the
upload response's permanent `url` in single-file content or its `ref` in a bundle
`files` map → `publish` → inspect the rendered artifact. Staging alone does not publish
an artifact.

## Fully-styled HTML

A single-file artifact with its own `<style>`, scripts, fonts and images renders
as-authored in the sandboxed viewer (note: the `read` tool FLATTENS HTML to text — that
reading view is not what a viewer sees). Two rules:

- Declare your own `<meta name="viewport">`. Pages without one get a mobile-reflow
  injection whose media caps can fight intentional layouts; `data-reflow-exempt` on an
  element is the per-component escape hatch.
- Self-host binaries via a stage target:'asset' upload URL (images AND woff2 fonts) instead
  of base64.

After publishing a styled page, call `read` with `render:"top"` (or `"full"`/`"marked"`)
to SEE what shipped — a screenshot of the served page catches visual breakage (a failed
font, a broken layout) that no text read can. The screenshots are computed a few seconds
after each publish.

**Building slides? Read `derive://skills/decks` first.** A deck is single-file HTML like any
other page, but it has to announce itself over the `derive-deck` protocol to get the
presentation bar, Present mode, and comments that pin to a slide — and a deck that skips
that still looks right, so the loss is invisible. `derive://decks/template` is a complete
working starter.

## stage target:'doc' for large docs and bundles

Inline `content`/`files` is model output — capped by the per-response token ceiling and
forced into slow, costly multi-turn chunking once a file is bigger than a page or two (and
publish REJECTS an inline payload past ~64KB). For a document too large to inline (a big
designed HTML page or a multi-file bundle), call `stage` with target:'doc' and curl the
file/zip to the returned URL instead of chunking it through content/files — zero bytes
through the model's context.

Omit `short_id` to CREATE a new artifact; pass a `short_id` to REVISE that one (the token is
scoped to exactly that target). Then from your shell: a single file → `curl -sS -F
file=@page.html -F title='My Page' <upload_url>`; a bundle → zip the dir first (`cd site &&
zip -r /tmp/site.zip .`) then `curl -sS -F file=@/tmp/site.zip <upload_url>` (a .zip
publishes as a multi-page bundle). The URL is reusable until it expires (~15 min). Prefer
the plain publish tool for small docs and for surgical `edits`; reach for stage target:'doc'
only when inlining would chunk.

## Structured facts (publish numbers you can read back)

A page you republish on a schedule is a time series you cannot query: answering "how did
this trend over thirty days" means re-reading and re-parsing thirty of your own old pages.
A **facts** fixes that. Put the numbers in the document as an inert block, and Derive
extracts them per version so you can read them back as JSON.

The block lives IN the page (so it can never drift from what the page shows, and it
travels through every publish path for free — inline, staged, REST, CLI, the editor):

```html
<script type="application/derive-facts" data-fact="checks">
{"date": "2026-07-29", "pass": 44, "fail": 0}
</script>
```

In markdown, a fence whose info string names the fact:

````markdown
```derive-facts checks
{"date": "2026-07-29", "pass": 44, "fail": 0}
```
````

Read it back with `read`: `data:"checks"` returns that slot's JSON for the version,
`data:"*"` lists the facts a version carries. Pass `version` to read a past one.

**The trend read.** Versions are the time axis, so one call spans them —
`data:"checks", versions:"all"` (or `"1-30"`, `"12"`, `"20-"`) returns the series
oldest-first, one point per version that carries the fact:

```
read(short_id, data:"checks", versions:"all")
→ { count: 30, series: [ {n: 1, at: "…", data: {pass: 41}}, … ] }
```

Versions carrying no such slot are absent and the response says how many. Capped at 200
points; past that it tells you and hands back the range to ask for.

**Across artifacts.** `find(data:"checks")` reads that slot from EVERY artifact that
carries it (each one's current version), and `find(data:"checks", tag:"nightly")` scopes
it to a tagged set. `find(data:"*")` lists which facts exist in the workspace at all — the
way to discover a vocabulary you did not author.

**What links here.** `find(links_to:"<short_id or URL>")` returns every artifact whose
current version references that one — the inversion of the host-derived `$links` fact.
Reach for it instead of `find(query:"<short_id>")`, which ranks and caps a guess at
relevance: the index is exhaustive, and it counts only real link targets, never a short id
sitting in prose. Two gaps worth knowing: bundles and skills carry no facts, so references
inside their pages are never indexed, and a version published before derivation shipped
carries no row until it is read once.

Outside MCP, the same data is a URL: `GET /raw/<short_id>/data/<slot>.json` for the
current version, `/raw/<short_id>/v/<n>/data/<slot>.json` to pin one, and
`/raw/<short_id>/data/<slot>.jsonl` for the WHOLE series (one JSON object per version,
oldest first) — so a page can chart its own history, a shell can pipe it to jq, and
anything wanting SQL can point DuckDB at it. Same access as the artifact itself.

Rules worth knowing before you author one:

- Fact names are lowercase letters, digits and hyphens (up to 64 chars). First occurrence
  of a name wins.
- The body must be valid JSON. 32KB per slot, 20 facts per version, sizes counted in BYTES.
- A fact that can't be stored (bad name, invalid JSON, too big) NEVER fails the publish —
  it comes back as an advisory in the response, so read those.
- A literal `</script>` inside your JSON ends the block early (HTML rules, same as a
  browser) — write it `<\/script>`.
- Facts are per VERSION and immutable, like the version itself. Republishing without the
  block simply means that new version carries no slot; the old version keeps its own.
- Single-file HTML and markdown artifacts only (not bundles).

## content_sha256 verification

A single-file publish's response echoes `content_sha256` of the stored bytes (the
content-addressed blob key) — verify it when the content passed through your context, so
you know what landed matches what you sent.

## Proposals and review (the /derive loop)

`publish` goes LIVE immediately if your role can publish (Creator/Admin); otherwise — or
whenever you pass `for_review:true` — it is filed as a PROPOSAL a human approves before it
goes live. (Proposals are single-file only; bundles must be published directly.)

- **addresses**: pass the thread ids (from catch_up) this revision resolves. On a live
  publish they resolve; on a proposal they flip to `addressed` and resolve on approval.
- **request_review**: after a LIVE publish, open a review round asking your human to review
  this version — the /derive loop. They answer inline and hit Send back (or Approve); poll
  catch_up's `review` field for the state. No effect on a proposal (that already IS a
  review).

## Access on a NEW artifact

Access is set on create; a republish never re-stamps it. The factory default is the "team
draft" — `workspace_access=member`, `link_role=none`, `listed=none`: a teammate can open
the pasted link, the world can't, and it stays out of feeds until a human promotes it.
Sharing wider (`workspace_access`, `link_role`, `listed`) stays a deliberate act — see
those params' own descriptions for the exact meanings.

## Reaching REST from your shell (stage target:'api')

Your credential lives INSIDE this MCP transport: the connector holds it, your shell does
not. So a REST route that has no tool — and anything you want to script with curl — is
unreachable at the access you already hold, and hunting for a second credential (a CLI
login, its own scopes, its own expiry) is the detour that wastes a session.

`stage({target:"api"})` closes that: it mints a short-lived bearer for the access this
connection ALREADY has, so you can curl any route that access can reach.

- **Least privilege by construction.** Capped at your role in the target workspace, bound
  to that ONE workspace, ~15 minutes, not refreshable. Narrow it further with
  `access:"read"|"comment"|"publish"|"manage"` when the job needs less than you hold.
- **It cannot widen your reach.** Asking for more than the grant holds is refused, naming
  whether the SCOPE or your workspace ROLE is short — they need opposite fixes (re-consent
  vs an admin changing your seat).
- **It expires rather than refreshes.** When it lapses, mint another; that is one tool call,
  so there is no refresh token to rotate and no session to keep alive.
- **Treat it as the real credential it is.** It is not redacted from this transcript. Its
  blast radius is one workspace, one role, minutes — and removing the human from that
  workspace kills it immediately, mid-TTL.

Use `list_workspaces` first when unsure what you hold: it reports the principal kind, the
human you act for, your access ceiling, and per workspace what your role CANNOT do.
