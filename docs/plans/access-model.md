# The access model (v2): seat roles, the world link, and listing

Supersedes the round-3/round-4 shape ([visibility-collapse.md](./visibility-collapse.md),
[link-grant.md](./link-grant.md)). Those were right to make reach its own axis, but
`visibility` stayed overloaded — it bundled *discovery*, *membership access*, and a
*public-link implication* into one enum, which is what produced the 4 forbidden
states, the coherence rule, the no-op-floor redundancy, and the surprising
"a workspace editor can't edit an unlisted draft" behavior.

v2 splits those concerns into single-purpose fields. Decided 2026-07-08 (Rob): a
doc shared with the workspace grants each member their **seat role**, not a flat
per-doc role.

## The three fields

Every artifact carries, independently:

- **`workspace_access`: `none | member`** — do members of the artifact's workspace
  get in *at their own seat role* (owner → manage, editor → edit, commenter →
  comment)? This is the whole membership grant; there is no per-doc workspace role.
- **`link_role`: `none | viewer | commenter | editor`** — what **anyone holding the
  URL** gets (a non-member, the world, or an anonymous visitor). The *only* per-doc
  role. `link_audience` is gone: "a teammate with the link" is `workspace_access`,
  so the link is always the outside world.
- **`listed`: `none | workspace | public`** — pure discovery: does it appear in the
  workspace library / the public directory. **No access meaning.**

Plus, unchanged: `password_hash` (locks the world link), and explicit
`artifact_member` / collection shares.

## effectiveRole — the one gate

Three grants, maxed. No coherence rule; no illegal combinations.

```ts
effectiveRole(actor, workspaceAccess, linkRole):
  if actor is a token        -> "owner"          // operator/internal
  explicit = actor.artifactRole                   // a share or collection role, always
  seat     = workspaceAccess === "member" && actor is a signed-in member of THIS
             workspace ? actor.orgRole : null      // their SEAT role
  world    = linkRole === "none"        ? null     // link off
           : locked && !unlocked        ? null     // password gate
           : actor is a signed-in user  ? linkRole // any holder, member or not
           : "viewer"                              // anonymous clamps to viewer
  return max(explicit, seat, world)
```

Consequences that fall out for free:
- A workspace **editor edits an unlisted draft** (via `seat`), never floored to a
  link role — the v1 bug is gone.
- **Anir's paste-loop is the default**: `workspace_access=member, link=none,
  listed=none` — a teammate or an on-behalf agent opens a pasted link at their
  seat role; the world 404s until you deliberately set `link_role`.
- The **role dropdown only appears for "Anyone"** in the UI — Workspace uses seats,
  so it has no role, just a listing switch.

## Listing preconditions (the only invariants)

Discovery may not surface an artifact to an audience that cannot open it:

- `listed = workspace` requires `workspace_access = member`.
- `listed = public` requires `link_role ≠ none`.

These are "can't list what no one can open" — enforced at the write path, and the
UI never offers an invalid listing (the library switch only shows under Workspace;
the directory switch only under Anyone). There is no *contradiction* to coerce, so
unlike v1's coherence rule there are no forbidden two-field states.

## The state space (illustrative, not exhaustive)

| Intent | workspace_access | link_role | listed |
|---|---|---|---|
| Invite-only | none | none | none |
| **Team draft (default)** | member | none | none |
| Team doc (in the library) | member | none | workspace |
| Unlisted world link (Loom) | member¹ | viewer | none |
| Public | member¹ | viewer | public |
| Password-locked public | member¹ | viewer + password | public |
| Team doc + external view link | member | viewer | workspace |
| External-only (customer link, no workspace) | none | viewer | none |

¹ Members keep their seat regardless of the world link; set `workspace_access=none`
only for the rare "outsiders but not my own workspace" case.

Everything is representable; no combination is forbidden. The segmented UI
(Invited / Workspace / Anyone) surfaces the common rows first-class; the
workspace-listed-*plus*-world-link tail (row 7) is reachable by API / by adding
the outsider explicitly, as before.

## Migration (from production's post-#316 shape)

Prod rows carry `visibility ∈ {private, org, public}` + `general_role ∈
{viewer, commenter}` (the old public-link role). Add `workspace_access`, `listed`,
`link_role` columns (defaults `none`/`none`/`none`), then backfill idempotently:

```
workspace_access = visibility IN ('org','public') ? 'member' : 'none'
listed           = visibility = 'public' ? 'public'
                 : visibility = 'org'    ? 'workspace' : 'none'
link_role        = visibility = 'public' ? general_role : 'none'   -- world link
-- password_hash carries over unchanged (it locked the public link)
```

`visibility` and `general_role` stay as **orphaned** columns (expand/contract;
non-destructive), read by nothing after the backfill. `link_audience` was
round-4-only (never shipped) and is removed from the schema on this branch.

## Blast radius (implementation order, bottom-up)

1. `core/permissions.ts` — types (`LinkRole` = world role; add `WorkspaceAccess`,
   `Listed`; drop `LinkAudience`), rewrite `effectiveRole`/`can`. **+ tests.**
2. `core/ports.ts` — `ArtifactRecord`/`NewArtifact` fields, `setVisibility` →
   `setAccess(id, workspaceAccess, listed, linkRole, passwordHash)`, `OrgSettings`
   (`defaultWorkspaceAccess`, `defaultLinkRole`; drop `defaultLinkAudience`).
3. `db/schema.ts` + `pg-schema.ts` — columns + boot backfill; `repos.ts` + `pg.ts` —
   `setAccess`, `artifactListConditions`/listing filters keyed on `listed` +
   `workspace_access`. **+ store-contract tests.**
4. `apps/api` — publish defaults, the access endpoint, listing scope, `toJson`
   fields, `context` effectiveRole call sites + unlock; `mcp`/`cli` publish params.
   **+ visibility/link-grant tests.**
5. `apps/web` — `api.ts` types + `setAccess`; `share-dialog.tsx` v2 (Workspace = no
   role, listing switch only; Anyone = world role + listing + password). **+ e2e.**
