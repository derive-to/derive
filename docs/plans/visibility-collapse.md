# Round 3 — the visibility collapse & the social cut

Follow-up to [auth-workspace-simplification.md](./auth-workspace-simplification.md)
(rounds 1–2 shipped as #314). Round 3 reduces **state**, not presentation:

## Decisions (2026-07-07, Rob)

1. **Visibility collapses 6 → 3: `private` · `org` · `public`.** "Listed" was
   never an access property — it was a broadcast property, and broadcast is not
   a per-artifact state in this product. `public` means public: the link works,
   full stop (GitHub semantics — no "public but hidden" state exists there
   either). `org` means it's in the workspace library, no asterisks.
2. **Password becomes a lock on `public`, not a visibility.** `password_hash`
   set on a public artifact gates the bytes exactly as before (unlock cookie
   unchanged). A locked doc is *inherently* absent from readable surfaces — no
   stored listing flag needed. This also covers the entire legitimate
   "reachable but not broadcast" use case (client docs), better than `link`
   did: a leaked URL no longer exposes the doc.
3. **No listing axis anywhere. No "featured".** The workspace library lists all
   `org`+ docs. Profile/directory broadcast surfaces don't exist at launch
   (see 4), so `public` carries no broadcast clause at all.
4. **No global social at launch.** Identity infrastructure stays (@handles,
   avatars, author chips, share/invite typeaheads — that's addressing, not
   social). The social network is cut: no global people search, no
   follower/following counts, no following strangers, no public work grid for
   strangers, no directory. Follow survives **workspace-scoped**
   (server-enforced): the Following feed is work awareness, not social.
   Asymmetry argument: adding social later is a feature launch; removing it
   later is a takeaway. Schema/routes for follows stay — this is a surface +
   policy cut, not a demolition.

## Migration (boot task, alongside the legacy-org rekey pattern in node.ts)

| old            | new       | notes                                                    |
|----------------|-----------|----------------------------------------------------------|
| `unlisted`     | `private` | matches draft intent; owner rows preserve access; the    |
|                |           | member-with-link nicety is retired (promote = the gesture)|
| `link`         | `public`  | no broadcast surface exists, so nothing new leaks        |
| `password`     | `public`  | `password_hash` kept — the lock keeps gating             |
| `org`/`public`/`private` | unchanged |                                              |

Idempotent UPDATEs, sqlite + pg branches, same shape as the `'local'` rekey.
No production users — this window is free.

## The one-sentence model

> **Private (you + people you add) · Workspace (your team) · Public (the link
> works for anyone) — and a public link can take a password.**

## Load-bearing details

- **permissions.ts**: `Visibility = "private" | "org" | "public"`. Actor gains
  `locked` (artifact has a hash); public floor = `locked && !unlocked ? null :
  reach`. The `unlisted` and `password` branches — the two subtlest paths —
  are deleted. `GeneralRole` now only means "what the public link grants".
- **Cache safety**: `cacheControlFor` must consider the lock — a locked public
  artifact is `private, no-store` (per-visitor gate), never CDN-cacheable.
- **API compat**: `visibilityOf` maps legacy client values — `link → public`,
  `unlisted → private`, `workspace → org`, `password → public` (+ password
  still required to set a hash on create). Old MCP/CLI clients keep working.
- **setVisibility**: `password` param sets the hash; explicit empty/null
  clears; leaving `public` clears (a lock on a non-public doc is meaningless).
- **defaultAgentVisibility**: options `private | org`, default `private`
  (agent drafts are private — the blessing gesture is promotion).
  `defaultUnlistedRole` dies (setting, API field, UI row; DB column orphaned).
- **Pending badge**: was `countOwnedBy(…, "unlisted")` → becomes
  `countOwnedBy(…, "private")`. Honest limitation: a human's deliberately
  private doc counts too. Refinement (later, if noisy): stamp the publishing
  agent on versions and count only agent-authored latest. Not this PR.
- **Runner answer charts**: published `link` today so the asker can read them
  → publish `org` (askers are workspace members; "available in the workspace
  and that's fine").
- **Unlisted row chip / mine_link_only**: chip dies; summary field renames to
  `mine_private` with the same accent-badge role.
- **listArtifacts**: the `unlisted` include/exclude option dies entirely —
  `private` handling (viewer member rows) already covers drafts. MCP
  list_artifacts keeps finding the agent's work through the owner row.

## Social cut list (launch scope)

- `follows` routes: following a user requires a shared workspace (403
  otherwise). Existing follows of strangers: leave rows, they simply stop
  matching anything the feed can see.
- Profile page: strangers get the identity card (name/@handle/role/bio);
  work grid + follow button only for shared-workspace viewers (and self).
  Follower/following stats + dialogs removed.
- People page: browse = your workspaces' people + who you follow; the
  search-everyone section is removed. Command palette People group scopes to
  workspace members.
- `searchPeople` endpoint stays (share dialog + invite typeahead — addressing).
- Directory/Explore: nothing to remove server-side beyond `public` listing
  semantics; "Public — in the directory, indexable" copy dies with the dialog.

## Checklist

- [ ] A. Plan doc (this file) committed
- [ ] B. Core: Visibility 3-value, Actor.locked, effectiveRole rewrite, tests
- [ ] C. DB: listing machinery, migration boot task, store-contract
- [ ] D. API: aliases, unlock/cacheControl on hash, org settings, summary
      rename, mcp.ts enum, route + test updates
- [ ] E. Web: 3-row dialog + password checkbox, settings rows, badge rename,
      chip removal
- [ ] F. Social cut: follows enforcement, profile, people, palette
- [ ] G. Clients + docs: cli enum, packages/mcp, runner, README, SECURITY.md
- [ ] H. Gates (typecheck, lint, unit, e2e subset) + PR

## Deferred (recorded, deliberate)

- Agent-authored pending refinement (version agent stamp).
- Domain discovery at signup; defaults-by-location; roles collapse (unchanged
  from round 2's deferred list).
- Re-introducing profiles/follow globally + any directory — a post-launch
  feature launch, gated on real public content existing.
