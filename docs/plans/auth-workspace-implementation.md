# Auth/workspace/sharing simplification — implementation plan

Companion to [auth-workspace-simplification.md](./auth-workspace-simplification.md)
— read that first for the *why*. This doc is the concrete *what to touch*, in three
independently-shippable phases. (CLI/MCP `whoami` + multi-workspace credentials is
its own track — see Anir's PR — and isn't in this plan.)

## Phase 0: invite-accept email mismatch

`POST /v1/invites/:token/accept` (`apps/api/src/routes/workspace.ts:279-295`) joins
the signed-in caller to the workspace at the invited role without ever comparing
`inv.email` to the caller's own email. The design comment right above it
(`workspace.ts:260-262`, *"the token IS the secret ... mirroring the
password-artifact model"*) makes clear this was a deliberate choice, not an
oversight — so the fix is to **surface the mismatch, not silently block on it**,
keeping the no-email-verification-required self-host case working.

- **API** (`apps/api/src/routes/workspace.ts`):
  - `GET /v1/invites/:token` (`:263-275`) already returns `inv.email` in the
    preview payload — no change needed there.
  - `POST /v1/invites/:token/accept` (`:279-295`): if `inv.email` is set and
    doesn't case-insensitively match the caller's `me.email`, require an explicit
    `{ confirm_mismatch: true }` in the body; otherwise return `409` with a
    machine-readable `{ error: "email_mismatch", invited_email: inv.email }` instead
    of joining. Matching or absent `inv.email` behaves exactly as today.
- **Web** (`apps/web/src/pages/accept-invite.tsx:51-56` and the accept action):
  when the preview's `email` differs from the signed-in `me.email`, show an
  inline warning ("This invite was sent to `x@y.com` — you're signed in as
  `a@b.com`.") with an explicit "Continue anyway" before calling accept with
  `confirm_mismatch: true`.
- **Tests** (`apps/api/test/workspace.test.ts`): add a mismatched-email case
  (expect `409` without the flag, `200` with it) alongside the existing
  matching-email accept test.

Ships alone, no dependency on phases 1/2.

## Phase 1: relabel the visibility ladder, retire the Drafts tab

No schema change — `private`/`org`/`unlisted`/`link`/`public`/`password`
(`packages/core/src/ports.ts:21`) stay exactly as they are underneath. This is
copy + UI grouping + one cross-surface consistency bug.

### 1a. Share dialog copy + grouping

`apps/web/src/pages/artifact/share-dialog.tsx:41-78` — the `ACCESS` array:

| value | old label | new label |
|---|---|---|
| `private` | Private | Private *(unchanged)* |
| `org` | Workspace only | Workspace |
| `unlisted` | Draft — workspace with link | Workspace — link only |
| `link` | Anyone with the link | Anyone with the link *(unchanged)* |
| `public` | Public — listed | Public |
| `password` | Password protected | Password protected *(unchanged)* |

Reorder the array so `org`/`unlisted` sit as an adjacent pair and `link`/`public`
sit as an adjacent pair (they already do, modulo the label swap) — optionally add
a small group divider/subheading ("Workspace" over the first pair, "Anyone" over
the second) so the who × listed-or-link-only structure is visible, not just
implied by list order. Treat the divider as polish, not a blocker.

`apps/web/src/pages/settings/general-section.tsx:281,292` — `AGENT_VIS_LABELS`:
update the `unlisted → "Draft"` entry to `"Workspace — link only"` so the
"agent publishes as" setting uses the same vocabulary as the share dialog.

### 1b. Library: drop the Drafts tab, add "Created by me"

`apps/web/src/pages/library/index.tsx`:

- `deriveFilter` (`:73-91`): drop the `search.tab === "drafts"` branch (`:82`)
  and the `unlisted` scope shortcut in `params` (`:128`).
- `LibraryTabs` (`:644-681`): currently a 2-tab row, "All artifacts" / "Drafts"
  (`:677-678`). Replace with "Everything" / "Created by me". Wire "Created by
  me" through the **existing** author-filter plumbing — `pickAuthor`
  (`:223`, already used when you click an author chip) sets `search.author`,
  which already flows into `params.author` (`:127`) and the server query. "Created
  by me" is just `pickAuthor(me.username)` with its own tab affordance instead of
  a chip click.
  - "Shared with me" does **not** need new work — it already exists as the
    `/shared` route (`nav-rail.tsx:470-472`, heading "Shared with you" at
    `index.tsx:275`). Decide whether it also gets a shortcut inside this tab row
    or stays a separate rail item; either is fine, note the decision in the PR.
- `heading`/`headingCount` (`:267-298`) and `emptyStateFor` (`:699+`, the
  `unlisted` case around `:728`): drop the `unlisted` branches, add an
  "author === me" branch if the new tab needs its own heading/empty copy.
- Update the stale comment at `:641-643` ("the empty Drafts tab is how the
  concept gets discovered") — that rationale is gone.
- `apps/web/src/pages/library/types.ts:47-50`: update the comment describing
  `unlisted` as "drafts, renamed for humans" to match the new framing.

### 1c. Cross-surface consistency + stale copy

- `packages/cli/src/config.js:239` — the `derive.json` visibility enum is
  missing `unlisted`: `["public", "link", "org", "password", "private"]` →
  add `"unlisted"`. Independent bug, fix regardless of the naming change.
- `packages/mcp/src/index.ts:344-345` — update the comment ("a DRAFT: hidden
  from the library...") to the new framing (hidden from the workspace library,
  reachable by link for members).
- `apps/web/src/components/showcase/showcase.tsx:466-470` — the design-system
  demo shows a "Draft" badge next to "Published" as if they're lifecycle
  opposites. Remove or relabel so the showcase stops teaching the wrong mental
  model.
- `SECURITY.md:32-59` — update the `unlisted` row's wording (currently "the
  agent-draft state between private and workspace") to match.

### Tests

`apps/web/e2e/deep/library.deep.spec.ts`, `smoke/library.smoke.spec.ts`,
`deep/visibility.deep.spec.ts`, `deep/share.deep.spec.ts` — rename/update any
assertions keyed on `data-testid="library-tab-drafts"` or the old "Draft" copy;
add coverage for the new `library-tab-created-by-me` (or equivalent) test-id.

## Phase 2: signup fork + hide "workspace" language for solo accounts

This phase is more product-judgment than mechanics — flagging open decisions
inline rather than pretending they're already resolved.

### 2a. Signup fork

`apps/web/src/pages/welcome.tsx` is already the post-signup onboarding step
(profile, avatar, profession — no workspace question today). Add a first screen:
**"Personal account" / "Create a company account."**

- Personal → no change, proceed to the existing profile fields; the silently
  auto-provisioned `ws_p_<userId>` workspace (`apps/api/src/context.ts:451-461`)
  stays as-is and is never labeled "workspace" in the UI (see 2b).
- Company → prompt for a workspace name (and optionally teammate emails right
  there, reusing `POST /v1/workspace/invites`), then call the existing
  `POST /v1/workspaces` (`apps/api/src/routes/workspace.ts:367-381`), which
  switches the active-workspace cookie to the new one.

**Decision needed:** the auto-provisioned personal workspace still gets created
first (it's the fallback every workspace-scoped call relies on, including
paths that never touch `/welcome` — CLI, MCP, agents). For a "company" signup
this leaves two workspace rows: the invisible personal one and the new named
one. Recommendation: leave the personal one in place rather than trying to
suppress/merge it — it's harmless once it's not labeled "workspace" anywhere
(2b), and avoiding a race with whatever pre-`/welcome` API calls already fire
`activeWorkspace()` is not worth the complexity. Confirm this is acceptable
before building 2a.

### 2b. Hide "workspace" language for single-member workspaces

Needs a cheap way to know "is the active workspace solo" on the client —
check whether `GET /v1/workspaces` (`workspace.ts:331-364`) already exposes a
member count; if not, add one. Then:

- `apps/web/src/components/chrome/app-shell.tsx` (switcher, `:59-140`): only
  render the switcher when the caller belongs to more than one workspace.
  Note: earlier research found a vestigial `multi` flag that's hard-coded
  `true` everywhere (`workspace.ts:72,347,353,360`) with a comment calling the
  switcher "dormant in single mode" (`apps/web/src/api.ts:1076`) — that dead
  single/multi toggle should either be wired to real membership count here or
  removed; don't leave a third half-implemented flag alongside the new check.
- `apps/web/src/pages/settings/general-section.tsx:34-57`: relabel the
  "Workspace" section "Account" when solo; only surface workspace-name editing
  and the switcher once there's a second member or the account was created via
  the "company" fork.

### Tests

`apps/web/e2e/deep/chrome.deep.spec.ts` (switcher visibility),
`smoke/auth.smoke.spec.ts` / `deep/auth.deep.spec.ts` (signup fork),
`deep/settings.deep.spec.ts` (Account vs Workspace labeling) — extend for both
the solo and multi-member cases; a fresh signup in the e2e harness is
single-member by default, so the "hide workspace language" assertions are the
default path and multi-member needs an explicit second invite in the test.

## Dev loop (each phase)

```bash
cd apps/api && PORT=8200 DATA_DIR="$PWD/.data-mine" \
  DERIVE_WEB_ORIGIN=http://localhost:3200 BASE_URL=http://localhost:3200 pnpm dev
cd apps/web && DERIVE_API=http://localhost:8200 pnpm exec vite --port 3200 --strictPort
```

Sign up fresh (first user on a fresh DB = workspace owner); invite a second
account to exercise the multi-member paths.

## Verify (gate for "done," each phase)

- `pnpm typecheck` — clean.
- `pnpm lint` (biome) — clean; `pnpm lint:testids` if new test-ids were added.
- `pnpm -r test` — API unit tests (`apps/api/test/*`) green, including the new
  Phase 0 mismatch cases.
- Relevant Playwright specs green:
  `cd apps/web && pnpm exec playwright test e2e/deep/library.deep.spec.ts e2e/deep/share.deep.spec.ts e2e/deep/visibility.deep.spec.ts e2e/deep/chrome.deep.spec.ts e2e/deep/auth.deep.spec.ts e2e/deep/settings.deep.spec.ts`
  (parallel worktrees: set distinct `PW_WEB_PORT`/`PW_API_PORT`).
- Screenshot the share dialog and library home in all 4 themes.

## Ship

- One PR per phase — they're independently useful and independently risky
  (Phase 0 is a security fix, Phase 1 is pure UI, Phase 2 touches onboarding).
- Own branch off `main`: `fix/invite-email-mismatch`,
  `refactor/visibility-relabel`, `feat/signup-fork`.
- No external references in commits/PRs (product-only).
