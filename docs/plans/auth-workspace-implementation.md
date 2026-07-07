# Auth/workspace/sharing simplification — round 2 working doc

Companion to [auth-workspace-simplification.md](./auth-workspace-simplification.md)
— read that first for the *why*. This doc is the living plan for PR #314, which
now carries the whole first tranche: the review fixes to the original relabel
work, the two-axis share dialog, the pending-work signal, and workspace-at-first-
need. (CLI/MCP `whoami` + multi-workspace credentials stays its own track —
**PR #308**, which lands `derive.json` workspace targeting, multi-account
credentials, and `X-Derive-Workspace` plumbing client-side.)

**Overlap with #308** (whoever merges second rebases; all trivial):
`GET /v1/workspaces` (#308 adds `account`, we add `personal` per entry),
`packages/cli/src/config.js` (our enum fix vs. their store rewrite),
`packages/mcp/src/index.ts` (our copy fix vs. their auth rewiring).

Checklist convention: `[x]` done on this branch · `[ ]` still to do.

## Decisions locked (2026-07-07, Rob)

1. **Identity model stays**: one account, many workspaces. No per-company
   accounts, no multi-email (post-launch, GitHub-style verified emails).
2. **All six visibility values stay** — presented as two axes: WHO (private /
   workspace / anyone) × LISTED-OR-LINK-ONLY (for the workspace and anyone
   tiers). "Draft" as a word is retired everywhere.
3. **The signup fork is CUT** (the old Phase 2a). No workspace question at
   signup or in `/welcome`. The workspace concept materializes *at first need*:
   the share dialog's team rungs (solo users see a create-a-workspace hint
   instead), one create-workspace flow with invites included, and the switcher
   only once ≥2 workspaces exist. `/welcome` gets one non-branching pointer
   line. Post-launch growth lever: domain discovery ("3 people from churnkey.co
   are already here"), not self-reported intent.
4. **"Created by me" keys on the owner member row**, not the `author_id`
   denorm (which `addVersion` overwrites with the latest publisher — including
   NULL on token republishes). Google Drive's "Owned by me" precedent: stable
   under republish, agent-aware (the owner row is written for the on-behalf
   human at creation), transfer-aware. Co-owners added via the share roster
   see the doc under their own "Created by me" too — accepted.
5. **"Everything" reverts to "All artifacts"** — the one feed that deliberately
   hides link-only work must not be named Everything.

## Workstream A — fixes to the round-1 relabel (review findings)

- [x] **A1. Owner-row semantics.** Replace `artifactIdsByAuthorId` /
  `countAuthoredBy` with `artifactIdsOwnedBy(orgId, userId)` /
  `countOwnedBy(orgId, userId, visibility?)` keyed on
  `artifact_member(user_id, role='owner')` joined to `artifact.org_id`.
  Sites: `packages/core/src/ports.ts` (interface), `packages/db/src/repos.ts`
  (sqlite+d1), `packages/db/src/pg.ts`, `apps/api/src/routes/artifacts.ts`
  (`scope=mine` narrow + `/v1/tags` summary). The optional `visibility` arg
  also powers workstream C's pending count.
- [x] **A2. Republish-stability contract tests.** In
  `packages/db/test/store-contract.ts`: an artifact whose owner row is user A
  stays in A's ids/count after (i) `addVersion` authored by user B and (ii)
  `addVersion` with `author_id: null` (the token/CI republish). These are the
  cases that broke the `author_id` approach.
- [x] **A3. Index.** `index("artifact_member_by_user").on(t.user_id)` in
  `schema.ts` + `pg-schema.ts` (boot DDL generates CREATE INDEX from the table
  defs, so no separate migration). `countOwnedBy` runs on every `/v1/tags`.
- [x] **A4. Remote MCP copy.** `apps/api/src/mcp.ts` — the publish tool's
  visibility description still says "a DRAFT: hidden from the library" and
  `list_artifacts` says "your own unlisted drafts". Reword to the
  link-only framing (the stdio shim in `packages/mcp` was already done).
- [x] **A5. "Draft link permission" label.** `general-section.tsx` — the
  `defaultUnlistedRole` row still says Draft; rename to the link-only
  vocabulary (label + aria-label).
- [x] **A6. `?tab=drafts` alias.** `routes/index.tsx` validateSearch maps the
  legacy `tab=drafts` → `mine` instead of dropping it (old bookmarks,
  agent-emitted links).
- [x] **A7. Revert "Everything" → "All artifacts"** (nav-rail, command-palette,
  library heading + tabs, showcase eyebrow demo, e2e copy).
- [x] **A8. Stray comment sweep** — `routes/artifacts.ts` "the draft state"
  comment and any remaining user-facing "draft" in the renamed surfaces.

## Workstream B — the two-axis dialog

- [x] **B1. Grouped dropdown.** `share-dialog.tsx` `ACCESS` becomes grouped
  sections rendered with separators (extend `ui/select-menu.tsx` with a
  `SelectMenuSeparator` wrapper over the existing dropdown primitive):

  | | label | value |
  |---|---|---|
  | · | Private | `private` |
  | ─ | Workspace | `org` |
  | | Workspace — link only | `unlisted` |
  | ─ | Public | `public` |
  | | Public — link only | `link` |
  | ─ | Password protected | `password` |

  The 2×2 reads: listed first, link-only second, in each audience pair.
  `link` is renamed **"Public — link only"** (exact YouTube semantics; the
  blurb keeps "Anyone with the link can view" so the familiar phrase
  survives). Icons: listed rungs carry the audience glyph
  (workspace/globe), link-only rungs carry the link glyph. Password stays a
  trailing modifier-style rung (folding it into a checkbox on the link rungs
  is a later, larger change).
- [x] **B2. Showcase `GeneralAccessDemo`** mirrors the same grouping/labels.

## Workstream C — pending-work signal in Created by me

- [x] **C1. Summary count.** `/v1/tags` adds `mine_link_only` =
  `countOwnedBy(org, me, "unlisted")`. Types in `api.ts` + `library/types.ts`.
- [x] **C2. Tab badge.** The Created by me tab keeps its total count; when
  `mine_link_only > 0` it also shows a small accent count — the "waiting on
  you to surface it" signal the old Drafts badge carried.
- [x] **C3. Row chip.** In the Created by me feed, `unlisted` rows show a
  quiet "Link only" chip so pending work is scannable in place. (Check the
  card component for an existing chip/badge slot; reuse it.)

## Workstream D — workspace at first need

- [x] **D1. Solo ladder collapse.** In the share dialog, when the active
  workspace has one member (from the existing `GET /v1/workspace` roster via
  `workspaceQuery`), hide the `org` and `unlisted` rungs (unless one is the
  artifact's *current* visibility) and render a quiet footer hint: "Working
  with a team? Create a workspace to share with them" → Settings → General.
- [x] **D2. One-flow create + invite.** The create-workspace dialog
  (`general-section.tsx`) gains an optional "Invite teammates" field
  (comma/space-separated emails). Flow: `POST /v1/workspaces` (switches the
  cookie server-side) → `POST /v1/workspace/invites` per email (now scoped to
  the new workspace) → reload. Skippable — empty field behaves exactly as
  today.
- [x] **D3. User-pod entry point.** "New workspace" item in the pod menu
  (below the switcher section; also present for solo accounts) → navigates to
  Settings → General with a search param that auto-opens the create dialog.
- [x] **D4. Personal pinned.** `GET /v1/workspaces` marks the caller's
  personal workspace (`id === ws_p_<userId>`) with `personal: true` (both the
  human branch and the OAuth-agent owner branch). Web: `WorkspaceSummary`
  gains the flag; switcher + command palette display it as **"Personal"**,
  sorted first; the nav-rail subtitle shows "Personal" when it's active.
- [x] **D5. `/welcome` pointer.** One muted, non-branching line near the
  connect-agent step: "Working with a team? Create a workspace and invite
  them anytime from Settings."

## Workstream E — invite-accept email mismatch (old Phase 0, unchanged spec)

- [x] **E1. API.** `POST /v1/invites/:token/accept`: when `inv.email` is set
  and doesn't case-insensitively match `me.email`, return
  `409 { error: "email_mismatch", invited_email }` unless the body carries
  `{ confirm_mismatch: true }`. Matching/absent email: unchanged.
- [x] **E2. Web.** `accept-invite.tsx`: on preview-email ≠ session-email, show
  the inline warning + "Continue anyway" that resends with the flag.
- [x] **E3. Test.** `apps/api/test/workspace.test.ts`: 409 without flag, 200
  with it.

## Deferred (explicitly NOT this PR)

- Hide-workspace-language polish for solo accounts beyond the ladder (the old
  Phase 2b: "Account" vs "Workspace" settings labels, switcher chrome rules).
- Defaults-by-location (human publish in a team workspace defaults to `org`).
- Roles collapse (Admin / Member / Viewer; retire the vestigial `viewer`).
- Password as a checkbox on the link rungs instead of a sixth rung.
- Domain discovery at signup.
- CLI/MCP workspace targeting (`derive.json` workspace field) — PR #308.

## Dev loop

```bash
cd apps/api && PORT=8200 DATA_DIR="$PWD/.data-mine" \
  DERIVE_WEB_ORIGIN=http://localhost:3200 BASE_URL=http://localhost:3200 pnpm dev
cd apps/web && DERIVE_API=http://localhost:8200 pnpm exec vite --port 3200 --strictPort
```

## Verify (gate for "done")

- `pnpm typecheck`, `pnpm lint`, `pnpm lint:testids` — clean.
- `pnpm -r test` — including the new A2 contract cases (sqlite; `pnpm test:pg`
  for the Postgres adapter when Docker is available) and E3.
- Playwright: `library.deep`, `share.deep`, `visibility.deep`, `chrome.deep`,
  `settings.deep`, `mcp-loop.deep` (+ smoke for library/auth).
- Screenshot the grouped share dialog (solo + team) and the library tabs.

## Ship

One PR (#314), commits grouped by workstream so each is reviewable alone:
`fix: created-by-me keys on the owner row`, `fix: finish the draft→link-only
rename`, `feat: two-axis share dialog`, `feat: pending-work signal`,
`feat: workspace at first need`, `fix: invite email mismatch surfaced`,
`docs: round-2 plan`. PR description rewritten at the end to match reality.
No Claude attribution anywhere.
