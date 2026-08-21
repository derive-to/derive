# Changelog

All notable changes to Derive are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

## [0.2.0] - 2026-08-12

The first tagged release with the self-hosting distribution path. It includes the
published GHCR image, a release-bundled Compose/env pair, pinned image digest,
SHA-256 checksums, and GitHub build attestation. See the
[self-hosting quickstart](apps/docs/content/self-hosting/quickstart.md)
for the recommended install and verification flow.

## [Unreleased]

### Removed
- **The built-in template catalog and `@derive-to/templates`.** The 30 code-defined
  starters, the `derive://templates/catalog` and `derive://templates/<id>` MCP
  resources, and the built-in form of `derived_from` are gone; templates are artifacts
  tagged `template` (see Changed). `derived_from` takes an artifact short id or a
  library-entry URI. The npm package `@derive-to/templates` ends at 0.1.0 and is being
  deprecated. A database that holds built-in lineage strings from the retired form
  (`derived_from LIKE 'derive://templates/%'`; none on derive.to) can clear them with
  `deploy/drop-built-in-template-lineage.sql`; until then those rows read as
  underived.
- **Proposals and the approval step.** The two review ceremonies are gone: ask-first
  candidate versions awaiting an editor's decision, and the `approved` round state with
  its served-version pointer. Review is one loop: every write publishes live as a kept,
  restorable version; a review round is `pending` until the reviewer **Sends back**
  their answers; and the note on that send-back is the whole decision — a note that
  reads "good to go" is the go-signal. Gone with them: the
  `/v1/artifacts/:id/proposals` routes and proposal storage, the `addressed` comment
  state (threads are `open`/`resolved`/`outdated`), the `for_review` publish parameter
  (`request_review` is the one ask), the approve endpoint, the Slack Approve buttons,
  the `derive:propose` and `derive:review` OAuth scopes (existing grants keep
  refreshing — the strings grant nothing), and approved-version pinning for skill
  delivery — every read serves `current_version`. Existing databases run
  `deploy/drop-proposals.sql` then `deploy/drop-approved-version.sql` once after
  deploying; each normalizes persisted state before dropping the storage. The decision
  record is `docs/decisions/0001-one-review-loop.md`.
- `@derive-to/mcp` 0.6.0 — the stdio server matches the server: `publish` drops
  `for_review`, the client drops `propose`, and a review round reports
  `pending`/`sent_back`.
- `@derive-to/cli` 0.5.0 — `derive approve` is gone; `derive send-back --note "…"` is
  the human verb. Skill fetching reads current versions.

### Fixed
- **A filtered listing skipped the listing gate.** In the shared list query, the rule that
  keeps an unlisted (`listed: none`), members-only artifact out of a viewer's listing was
  an `else` hanging off whichever filter sat above it, so a typed listing (`find
  skills:true`, and now a tag-defined shelf) listed rows the viewer could not open. The
  gate is its own condition now; a store-contract case and a same-workspace HTTP case
  pin it.
- `@derive-to/templates` 0.1.0 — published, standalone. `@derive-to/mcp` 0.6.0 went to
  the registry depending on this package before it existed there, which made 0.6.0
  uninstallable (the same class of failure as mcp 0.4.0's raw `workspace:*` protocol).
  The package now carries its own generated deck starter instead of depending on the
  internal `@derive/core`, and CI fails when a published package's workspace
  dependencies reach outside the published set.

### Changed
- **Templates are artifacts.** The Templates page, `GET /v1/templates`, and `find
  templates:true` now list artifacts carrying the `template` tag: the active workspace's
  own first (`shelf: "workspace"`), then public ones from any workspace
  (`shelf: "public"`), each a real render with its author. Starting from one is the
  ordinary copy ("Make a copy", `POST /v1/artifacts/{shortId}/use`) or the agent handoff
  by short id. The 30 built-in definitions in `@derive-to/templates` no longer feed
  these surfaces; `/v1/templates` returns artifact rows (the `BuiltInTemplate` schema
  is gone from the OpenAPI document), the Contexts tab is gone, and the Libraries tab
  is hidden behind a flag while `?tab=libraries` keeps working.
- **Agent writes publish live, and the write policy is one switch.** An agent's write
  lands exactly like a person's: a new version with the full publish fan-out (bell,
  email, Slack, the open tab live-reloads). Asking for a look is `request_review` on
  the publish, and the round, the email, and the Slack DM all carry the requester's
  note. The five-dimensional write-policy machine (killswitch, workspace auto opt-in,
  per-target publish/draft mode, model-confidence floor, outside-data rule) collapsed
  to one workspace setting, `agentWrites`, on by default: off, agents stop writing
  everywhere an agent credential can write — runs are neither materialized,
  dispatched, nor claimed; chat's publish refuses with the drafted change surfaced in
  the reply; agent-credentialed publishes are refused at the API on every surface;
  staged upload URLs refuse at mint and at spend. A workspace whose legacy killswitch
  was engaged upgrades to writes-off. An agent's write to the workspace brand profile
  always opens a review round — its reveal is never silent.

### Added
- **Reversible artifact archiving.** Artifacts can leave the active library without being
  deleted, appear in a dedicated archive, and be restored later.
- **A standalone public documentation site.** `docs.derive.to` now publishes the product,
  self-hosting, architecture, API, and agent guides from canonical sources in this repository,
  with local search and Markdown representations for agents.
- **Collection and tag filters in search.** Artifact discovery can be narrowed to a collection
  or tag instead of relying on a free-text query alone.
- **Shareable collections.** Collections can be shared through role-bearing links and protected
  with a password, using the same hardened access model as artifacts.
- **What links here.** `find(links_to:"<short id or URL>")` returns every artifact in the
  workspace whose current version references that one. Until now the only way to ask was
  `find(query:"<short id>")`, which ranks and caps a guess at relevance — on the real
  library it returned 3 artifacts where 18 contained the string, one of them a fuzzy match
  about SVG gradients. The alternative was pulling every artifact's `$links` payload and
  inverting it client-side, which is capped at 200 rows and so is not merely slow but
  incomplete. This is exhaustive, and it counts only real link targets: a short id sitting
  in a paragraph is a string, not an edge. It is a query rather than a table on purpose —
  the answer for one target is small even though the scan is corpus-sized, and an inversion
  computed from the rows it inverts cannot silently disagree with them. Bundles and skills
  carry no facts at all, so references inside their pages are never indexed, and the empty
  answer says so rather than implying the target has no inbound links.
- **Chat replies arrive as they are written.** An attended turn used to be a spinner
  until the whole answer landed, which on a long reply is twenty seconds of nothing.
  The model's text now streams to the asker as a `session.delta` event on their own
  `u:<id>` channel, rendered into the same bubble the settled message lands in, so
  there is no jump when the transcript takes over. Deltas are a **view, never the
  record**: nothing is persisted until the turn settles, so a client that misses them
  loses the animation and nothing else. The `<revision>` block the reply contract asks
  for is cut from the stream — it is machinery rather than an answer, and the settled
  message strips it too. Slices are coalesced (a publish per 200 characters or 250ms,
  not one per token, because each is a Durable Object fetch), and a turn nobody is
  watching goes quiet after three of them reach an empty room — which is most turns,
  since an MCP ask or an API caller has no browser at all. Needs a gateway that serves
  SSE chat-completions; one that refuses is retried buffered, so streaming can never
  break a request that worked before.

### Changed
- **An attended turn now announces its own end.** `serveAttended` answers in-process,
  so it never went through the runner report path that publishes `session.settled` —
  a watching client learned the answer had landed only on its next poll. It now wakes
  the asker, and both the chat rail and the context console read the transcript on that
  event instead of waiting out the interval. With a live stream the rail's poll drops
  from 900ms to 5s, where it is the safety net for a dropped stream rather than the way
  the answer arrives.
- **Inline editing, second pass — the mode is legible and can't lose your work.**
  Entering edit mode used to be pixel-identical to reading: nothing on screen said
  the page had changed state, and you had to click something to discover what
  counted as text. Now the block under the pointer lights up as you move (the same
  resolver a click uses, so the invitation can never point at the wrong region), and
  the floating pill is a slim strip between the header and the document — in flow,
  so it can no longer cover the sentence you came to fix or swallow the click aimed
  at it. Leaving with unsaved edits asks first, through the house confirm dialog, on
  in-app navigation, tab close, Escape and Done alike; before, navigating away threw
  the typing out silently. **Escape** leaves the mode and **⌘S / ⌘Enter** saves
  (forwarded out of the sandboxed frame, which the host window can't hear). After a
  publish the editing chrome clears immediately instead of lingering, tinted, until
  the version swap lands. The comments rail stops telling you to select text for a
  comment while selection is editing text.
- **PR previews no longer render OG images into production.** The preview Worker
  inherited the `[browser]` binding and the `PREVIEW_RENDERER` durable object, whose
  sweep (`versionsMissingPreview`) is scoped by a row limit and nothing else — so a
  preview screenshots arbitrary PRODUCTION versions and writes the results back to the
  shared database. That was survivable while previews screenshotted production's own
  bytes; combined with the change below it would have overwritten real artifacts' cards
  with a branch's rendering, permanently (the sweep never revisits a version that
  already has an image). Previews now drop the renderer, and the vanity-subdomain base
  with it — a draft minted on a preview was writing a live `domain` row into
  production's table and then being served by production.
- **PR previews serve their own artifact bytes.** `DERIVE_SANDBOX_URL` was inherited
  verbatim by preview Workers, so every preview's `/raw/*` — including the injected
  `derive-client.js` — was answered by production. Any change to the in-iframe client
  (anchoring, cursors, decks, inline editing) was invisible in the preview that was
  supposed to demonstrate it. `preview-config.mjs` now unsets it, with a guard so it
  can't creep back, putting previews in the documented single-origin mode; the iframe
  sandbox and the `Content-Security-Policy: sandbox` response header are untouched.

### Added
- **Inline text editing.** An **Edit** button on the artifact workbench turns the
  rendered document itself into the editor: click any text, type, hit Save — a
  typo fix no longer needs the raw source or an agent round-trip. Works on phones
  too (the save bar floats above the comments sheet). Editing needs publish
  standing; a commenter suggests the change in a comment instead. Under the hood each
  changed run travels as a **quote-scoped edit** (`{ quote: { exact, prefix,
  suffix }, new_text }`) — the write-side twin of the comment anchor — resolved
  server-side against the stored source with a strict matcher (context match, else
  a globally unique exact, else refuse), so an edit can never land on the wrong
  occurrence. For HTML artifacts the resolved span maps back to raw bytes through
  an offset-tracking projection that refuses to cross markup or split an entity;
  replacements are escaped. The `edits` field on `POST /versions`
  and the MCP `publish` tool accepts the new shape as an alternative to
  `{old_str, new_str}` (one shape per batch — the two resolve against different
  baselines, so mixing is refused rather than silently reordered), with the same
  `base_version` conflict safety and an atomic all-or-nothing batch capped at 500
  edits per request.
  The shown version freezes while editing (a concurrent publish warns instead of
  reloading typed text away), comment anchors re-sweep as usual — a surgical
  inline edit keeps neighboring comments attached — and structural changes stay
  where they belong: chat and the source editor.

### Changed
- **Access is three single-purpose fields.** Replaced the overloaded `visibility`
  with `workspace_access` (does the artifact's workspace reach it, at each member's
  seat role), `link_role` (what merely holding the URL grants anyone — anonymous
  holders clamped to view), and `listed` (discovery only: the workspace library or
  public directory — no access of its own). A fresh publish defaults to the **team
  draft** — the workspace can open it at their seat role, there's no world link, and
  it's listed nowhere until promoted. The Share dialog is now a segmented
  Invited / Workspace / Anyone control, and the reach endpoint moved
  `PATCH /v1/artifacts/:id/visibility` → `/access`. Legacy `visibility` (+ its
  `link`/`unlisted`/`password`/`workspace` aliases) and `general_role` are still
  accepted on the wire, so a pinned `derive publish`/MCP client and saved
  `derive.json` files keep publishing unchanged; GitHub-mirror syncs stay
  workspace-listed. Changing an artifact's reach or lock requires standing
  (membership or an explicit share), not merely holding an editor link. The
  programmatic surfaces speak the same three fields: the MCP `publish` tool and the
  CLI (`--workspace-access` / `--link-role` / `--listed`, and the matching
  `derive.json` keys) — with the CLI's `--visibility` kept as a deprecated alias.
- **Agents act as their registrant.** The `agent` table gains `created_by`; an
  agent's publishes are attributed (`author_id`) and owned by that user, and the
  agent's per-artifact standing is *derived* from the human's member rows —
  capped at the agent's registered role and bound to its home workspace. Agents
  hold no member rows, so share rosters stay a human contract, and no agent can
  `manage` (delete/transfer) anything. Applies to the HTTP routes and the
  remote-MCP tools alike (MCP reads and listings scope invite-only artifacts — those
  with no workspace access — to the agent's human). Agents created before the column
  act as themselves; recreate the agent to link it.
- **`discoverable` is real profile privacy now.** Turning it off hides your
  profile page, work list, and follow lists from everyone except people who share
  a workspace with you (they 404, same as an unknown handle). Follower/following
  lists require a signed-in viewer regardless. The People directory gains a
  workspace-first view (`GET /v1/people?scope=workspace`).
- The publisher is recorded as their artifact's owner-member at creation, so
  ownership is explicit rather than implied by workspace role (and creators can
  manage their own artifacts in team workspaces).

### Added
- **Invite-only, org-wide collections, and a world-link password lock.** An artifact
  can be invite-only (`workspace_access=none`) so only explicit shares reach it, even
  for teammates. Collections are workspace-wide — any member manages one at their seat
  role and can organize any workspace-accessible artifact, not just their own. A
  password locks the world link (members and explicit shares never need it).
- Restructured the backend for clarity: `apps/api/app.ts` split into per-feature
  route modules over a shared app context; the SQLite and D1 database adapters
  collapsed onto a shared repository layer (one place to add a query); typed config
  and structured logging introduced. No behavior change.
- `@derive-to/mcp` 0.5.0 — `content_path` on `publish`: pass an absolute path and the
  stdio server reads and uploads the file's raw bytes itself, so page content never
  passes through the agent's context (no token cost, no transcription risk). The
  local file's sha256 is verified against the server's `content_sha256` echo — a
  corrupted upload is a hard error, and a clean one reports `content_verified`.
  Works for proposals (`for_review`) too; the filename defaults to the file's
  basename. Publish responses now also relay the server's `advisories`.
- `@derive-to/cli` 0.4.0 — republish carrying the `./publish` export the workspace
  gained in the unified cli/mcp publish refactor; npm's 0.3.0 predates it, which
  would have made mcp 0.5.0 uninstallable (its client imports
  `@derive-to/cli/publish`). Publish the CLI before the MCP server.
- Binary asset uploads for bundles: `POST /v1/assets` stores raw image bytes
  content-addressed (dedup by hash) and returns an `asset:<hash>` handle; a `publish`
  `files` value may now be that handle instead of an inline base64 data URI. An agent
  streams a screenshot up as binary (no base64 transcription) and references the tiny
  handle in the publish. PNG/JPEG/GIF/WebP, 25 MB each; served with the doc's visibility.
- Repository hygiene: `ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue + PR templates, `.editorconfig`.

### Fixed
- Artifact previews now refresh their raw-content token after expiry instead of leaving an
  otherwise accessible artifact with a broken preview.
- Account deletion preserves resources that were transferred to another owner, and ownership
  checks now stay scoped to the active workspace.
- `@derive-to/mcp` 0.5.1 — the stdio `read` tool now accepts `format:'html'`. Its
  schema only allowed markdown/text while the publish description said "read
  format:'html' first" before `edits` — following the server's own guidance was a
  validation error (remote `/mcp` always accepted html). Found dogfooding 0.5.0.
  Publish responses also surface `content_sha256` now, matching REST and remote.
- `@derive-to/mcp` 0.4.1 — republish with the `@derive-to/cli` dependency resolved to
  a real version. 0.4.0 shipped it as the raw `workspace:*` protocol (published with
  `npm` instead of `pnpm`), which is uninstallable; 0.4.0 is deprecated.
- `derive init` no longer hardcodes `visibility: private` into the scaffolded
  `derive.json` — it now inherits the workspace's team-draft default (workspace
  access at seat role, not listed), so a scaffolded project's first publish is
  reachable by teammates and on-behalf agents instead of invite-only.
- Root `dev`/`start` scripts now target the actual API package (`@derive/api`).

## [0.x]

Pre-release. Core artifact publishing + versioning, the comment/review loop,
collections, multi-workspace mode, quotas + rate limits, analytics, webhooks, the
MCP server, and the CLI. See the git history for details.
