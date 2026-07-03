# Changelog

All notable changes to Derive are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

## [Unreleased]

### Changed
- Restructured the backend for clarity: `apps/api/app.ts` split into per-feature
  route modules over a shared app context; the SQLite and D1 database adapters
  collapsed onto a shared repository layer (one place to add a query); typed config
  and structured logging introduced. No behavior change.

### Added
- Binary asset uploads for bundles: `POST /v1/assets` stores raw image bytes
  content-addressed (dedup by hash) and returns an `asset:<hash>` handle; a `publish`
  `files` value may now be that handle instead of an inline base64 data URI. An agent
  streams a screenshot up as binary (no base64 transcription) and references the tiny
  handle in the publish. PNG/JPEG/GIF/WebP, 25 MB each; served with the doc's visibility.
- Repository hygiene: `ARCHITECTURE.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue + PR templates, `.editorconfig`.

### Fixed
- Root `dev`/`start` scripts now target the actual API package (`@derive/api`).

## [0.x]

Pre-release. Core artifact publishing + versioning, the comment/review loop,
collections, multi-workspace mode, quotas + rate limits, analytics, webhooks, the
MCP server, and the CLI. See the git history for details.
