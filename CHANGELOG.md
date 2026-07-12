# Changelog

All notable changes to Derive are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

## [Unreleased]

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

### Added
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
