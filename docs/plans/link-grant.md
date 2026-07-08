# Round 4: the link grant (audience × capability)

Follow-up to [visibility-collapse.md](./visibility-collapse.md) (round 3, #316).
Round 3 collapsed visibility to three listing states and retired the `link`
tier, which also deleted link-reach entirely: a private artifact's URL was dead,
so every link pasted to a teammate dead-ended. Round 4 restores reach as its own
axis. Reach was never a listing property either, so it becomes a first-class
pair instead of a visibility value.

## The one-sentence model

> **Where it's listed** (private · workspace · public) says who can find it.
> **What the link grants** (`link_audience` × `link_role`) says who the URL
> works for and what it confers. The two never touch.

## Decisions (2026-07-08, Anir)

1. **The link grant is a PAIR on every artifact.** `link_audience`: `org`
   (signed-in members of the artifact's workspace) or `public` (any holder).
   `link_role`: `none` (inert, invite-only), `viewer`, `commenter`, `editor`.
   Together they express the three-stop dial: the link works for no one /
   people in my workspace / everyone, at a capability.
2. **Visibility stays a pure listing ladder.** Membership semantics unchanged:
   `org`/`public` fold in the member's workspace role; `private` grants members
   nothing by membership (a workspace owner still cannot open a teammate's
   sealed draft by role alone). The org-audience link uses membership as the
   audience KEY, not the grant: it hands a member `link_role`, never their
   workspace role.
3. **Anonymous stays clamped to viewer, and is never in an org audience.**
   The no-trusted-anonymous invariant from round 3 is untouched.
4. **Factory default: `private` listing + `org · commenter` link ("Workspace ·
   can comment").** A pasted link never dead-ends a teammate, and Derive is a
   review loop, so the link hands over the conversation, not just the read.
   Workspace-settable (`defaultLinkAudience` · `defaultLinkRole`); explicit
   request fields beat the setting. Set-on-create: a republish never re-stamps.
   **No retroactive widening**: changing a default never touches existing rows.
5. **Coherence rule (the only write-time constraint):** `visibility=public`
   requires a `public` link at `viewer` or above (GitHub semantics: public means
   the link works, full stop). An explicit contradiction is a 400, never a
   silent coercion. A bare `visibility=public` publish gets the classic
   **public · viewer** pair, NOT the workspace default role: the workspace
   default is chosen for the workspace audience and must never silently ride
   onto a world link (widening a public link past view stays an explicit act).
6. **The role ladder stays pure.** A link-granted editor is an editor: publish,
   approve, share (Google Docs semantics). No clamped pseudo-roles.
7. **Password lock scope unchanged.** Settable on a public listing only,
   suspends the link floor until unlocked; members and explicit shares never
   need it. Extending the lock to non-public link-bearing docs is deferred.
8. **Agent (MCP) publishes resolve the SAME default chain.**
   `defaultAgentVisibility` keeps governing the listing only: a draft stays out
   of the library until promoted, but its link works for the workspace it was
   handed to. That paste-loop is the reason this round exists.

## The full state table (the spec; SECURITY.md mirrors it)

"—" = no access (reads 404). "Member" = member of the artifact's workspace
holding the URL (or finding it where listed). Invited shares always keep
`max(share role, floor)` and are never blocked by a lock.

| # | visibility | link grant | Listed where | Anon + URL | Outsider + URL | Workspace member | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | private | none | nowhere¹ | — | — | — | invite-only (pre-round-4 private) |
| 2 | private | org · viewer | nowhere | — | — | view | **scenario 1** |
| 3 | private | org · commenter | nowhere | — | — | view + comment | **THE DEFAULT** |
| 4 | private | org · editor | nowhere | — | — | edit/publish | trusted-team drafts |
| 5 | private | public · viewer | nowhere | view | view | view | **scenario 2** (unlisted world link) |
| 6 | private | public · commenter | nowhere | view | comment | comment | scenario 2, commentable |
| 7 | private | public · editor | nowhere | view | edit | edit | anyone-with-link edits, opt-in |
| 8 | org | none | workspace library | — | — | membership role | team doc, link inert outside |
| 9 | org | org · viewer | workspace library | — | — | membership role² | valid, floor is a no-op |
| 10 | org | org · commenter | workspace library | — | — | membership role² | valid, floor is a no-op |
| 11 | org | org · editor | workspace library | — | — | max(role, edit) | team-editable |
| 12 | org | public · viewer | workspace library | view | view | membership role | team doc + external view link |
| 13 | org | public · commenter | workspace library | view | comment | membership role | team doc + external feedback |
| 14 | org | public · editor | workspace library | view | edit | max(role, edit) | coherent, risky, deliberate |
| 15 | public | none | — | — | — | — | **FORBIDDEN** (listed but unopenable) |
| 16 | public | org · any | — | — | — | — | **FORBIDDEN** (listed to world, link members-only) |
| 17 | public | public · viewer | library + world | view³ | view³ | max(role, view) | classic public · view (lockable) |
| 18 | public | public · commenter | library + world | view³ | comment³ | max(role, comment) | classic public · comment (lockable) |
| 19 | public | public · editor | library + world | view³ | edit³ | max(role, edit) | wiki mode, opt-in |

¹ Private appears in the owner's own library only (round-3 `mine_private`).
² Workspace roles are owner/editor/commenter (no bare viewer), so only the
editor floor ever lifts a member. ³ A password lock suspends these columns until
unlocked; members and invited shares pass by role regardless.

17 valid states, 4 forbidden, 0 ambiguous.

## Resolution (packages/core/src/permissions.ts, the one gate)

```
access = max( explicit standing , link floor )

explicit: artifactRole (share/collection) always; orgRole at org/public
          visibility only (nothing at private)
floor:    none => no floor; holder must be in the audience (public admits all,
          org admits signed-in members of the artifact's workspace); anonymous
          clamps to viewer; a lock suspends the floor until unlocked
```

## Storage + migration

- `artifact.link_role TEXT NOT NULL DEFAULT 'none'` and
  `artifact.link_audience TEXT NOT NULL DEFAULT 'org'`: fail-closed column
  defaults; publish() always stamps resolved values. `general_role` is orphaned,
  not dropped (expand/contract). DDL is generated from the drizzle defs
  (sqlite/pg/d1 in lockstep).
- Boot backfill (node.ts, idempotent, next to the round-3 remap):
  `UPDATE artifact SET link_role = general_role, link_audience = 'public' WHERE
  visibility = 'public'`. Public rows keep byte-identical reach; org/private
  links were dead and stay dead.
- Wire compat: publish + PATCH accept legacy `general_role`/`generalRole` as a
  role alias; `visibilityOf` keeps the round-3 legacy map (`link → public`,
  which now lands the classic public · viewer pair).

## Deferred (recorded, deliberate)

- Password lock on non-public link-bearing docs (natural now that private links
  exist).
- A request-access flow on inert links (blocked visitor pings the owner).
- Per-user default link pair (no user-settings store exists yet).
- Clamping `share` out of link-derived editors, only if the pure ladder proves
  scary in practice.
