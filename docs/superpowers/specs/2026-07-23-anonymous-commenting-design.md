# Anonymous commenting with a required name

**Date:** 2026-07-23 · **Status:** approved · **Driver:** Customer.io feedback (external-share feedback loops are blocked)

## Problem

An artifact shared with "Anyone with the link · Can comment" (`link_role = "commenter"`) does not actually let a logged-out visitor comment. Two deliberate gates block it:

1. The anonymous-write lockdown middleware 403s every non-GET from a non-principal before routing (`apps/api/src/app.ts:360-366`; comment paths are not in `ANON_WRITE_ALLOW`).
2. `effectiveRole` clamps any anonymous link-holder to `viewer` regardless of the link's role (`packages/core/src/permissions.ts:112-119`, "there is deliberately no 'trusted anonymous' path").

The UI mirrors the clamp: the composer is hidden and a "Sign in to comment" button renders instead (`apps/web/src/pages/artifact/index.tsx:784-799`).

The data model is NOT a blocker: `comment.author` is notNull, `comment.author_id` is nullable, and the create handler already computes a name-only author with `author_id: null` from a caller-supplied `body.author` (`apps/api/src/routes/comments.ts:191-209`) — currently unreachable dead code.

## Change

Open the two gates narrowly; no new endpoint, no schema change.

### 1. Permissions (`packages/core/src/permissions.ts`)

An anonymous holder of a commenter-or-better link resolves to `commenter`, capped there:

- `link_role = "none"` → anon: no access (unchanged)
- `link_role = "viewer"` → anon: `viewer` (unchanged)
- `link_role = "commenter"` → anon: `commenter` (NEW)
- `link_role = "editor"` → anon: `commenter` (NEW — **anonymous never exceeds commenter**)

Locked (password-protected) artifacts keep the existing unlock requirement before any role applies. Signed-in users are untouched (they continue to get the link's full role). The documented invariant in `permissions.ts` is rewritten to state the new rule: anonymous is never more than `commenter`, and only via an explicit commenter+ link.

Side effect (intended): `my_role` becomes `commenter` for these visitors, so the existing `canCommentWithRole` gate shows the composer with no bespoke UI wiring.

### 2. Anonymous-write allow-list (`apps/api/src/app.ts`)

Add ONLY the comment-create path (`POST /v1/artifacts/{shortId}/comments`) to `ANON_WRITE_ALLOW`. Edit, delete, resolve, and every other write stay principal-only. Authorization still happens in the route via `authorize(c, "comment", artifact)` — the allow-list only lets the request reach it, same pattern as presence/unlock.

### 3. Comment route (`apps/api/src/routes/comments.ts`)

- Anonymous create: require a non-empty trimmed `body.author` (max ~80 chars) → else 400. Store `author = name`, `author_id = null`. Never accept `body.author` from a signed-in caller (session name wins, as today).
- Comment reads (list/thread routes) must succeed for an anon caller whose effective role is `commenter` — the current `anonLocked`-style 404 applies only below commenter. A commenter must see the thread they're writing into.
- Rate-limit anonymous comment creation per IP using the existing rate-limit lib (`apps/api/src/lib/rate-limit.ts`) — e.g. a small burst + sustained cap; 429 beyond it. Signed-in callers are not affected.
- Mentions/notification fan-out: an anonymous comment triggers the same @mention emails and bells as today's flow, with the self-provided name as the author byline.

### 4. Web UI (`apps/web/src/pages/artifact/`)

- Composer: when logged out, show a required "Your name" field above the body field. Persist the name in `localStorage` (one prompt per browser). Sent as `author` on create.
- Keep a compact "or sign in" link near the composer (the seam the future "track this artifact" flow will grow into).
- Retire the "Sign in to comment" floating prompt: with the permission change, every case that used to trigger it (`isAnon` + commenter/editor link) now shows the composer instead. `shouldPromptSignInToComment` (`apps/web/src/lib/comment-access.ts:19-23`) and its render site go away.
- **Guest badge:** any comment whose `author_id` is null renders a subtle "guest" badge next to the name, everywhere comments render (panels, threads). Self-attested names must never be mistakable for verified identities.

### 5. Anti-abuse posture

- Scope: only artifacts whose owner explicitly set the link to commenter+. Private/view-only artifacts see zero behavior change.
- IP rate limit on create (above).
- Owners/editors can already delete comments — moderation exists.
- Anonymous commenters cannot edit or delete anything, including their own comments (no identity to authorize against).

## Out of scope (deliberate, tracked separately)

- "Track this artifact" prompt, email capture, per-artifact subscriptions, notify-on-new-version (task #3 decomposition)
- Anonymous→account conversion; "shared with you" association; copy-on-edit fork
- Per-workspace anything; CAPTCHA (revisit if abuse shows up)

## Testing

- **Permissions truth table** (`packages/core/test/permissions.test.ts`): anon × {none, viewer, commenter, editor} link → {none, viewer, commenter, commenter}; anon `can("edit")` false even on editor link; locked artifact → no role until unlocked; signed-in unchanged.
- **Route** (`apps/api/test/`): anon POST with name → 201, row has `author = name`, `author_id = null`; missing/blank name → 400; viewer-link artifact → 403; private artifact → 403; anon edit/delete → 403; rate limit → 429; anon list/read on commenter link → 200.
- **Web**: name field renders only when logged out; guest badge renders for `author_id = null` comments; signed-in composer unchanged.
