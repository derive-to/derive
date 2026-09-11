# Workspace join link: design

Status: approved 2026-09-10 (Connor). Source of record during design: Derive artifact `562f9sa2` (v7).

## Summary

One shareable, revocable link per workspace. Anyone who opens it joins at the role the
owner chose. Today an owner invites one email at a time and each invite is a single-use
token that dies in seven days. With a join link the owner pastes one URL into their team
channel and the team is in. Owner-only to create, revocable, seat-gated at join, expires
in 30 days, never grants owner.

## Why now

The GTM motion opens a door at a company and needs the team through it the same day: on
the demo call when the owner has just created the workspace, and the day after when the
owner says "send this to your team". Domain auto-join is the durable answer and is a
follow-up; the join link is the small PR that makes the motion work now.

## What exists today

- `invitation` table: one row per (workspace, email); token minted by `mintToken("dki")`,
  stored as sha256, 7-day TTL, single use via `consumeInvitation`.
- Invite routes in `apps/api/src/routes/workspace.ts`: create, list, resend (rotates),
  revoke, unauthenticated preview, authenticated accept. Owner-only via
  `requireWorkspace(c, "manage")`.
- Seat gate `seatGrantGate` (`apps/api/src/context.ts`): 402 `billing_required` when a billable
  role would exceed `FREE_SEAT_LIMIT` (3) with no active subscription.
- Signup admission (`apps/api/src/lib/signup-policy.ts`): a valid invite preview arms a
  15-minute `d_admission` cookie so the invitee can sign up when `DERIVE_SIGNUP_MODE=invite`.
- Redeem page `apps/web/src/pages/accept-invite.tsx`: signed out, "Sign in to accept" with
  `return_to`; after login the user clicks again. The `?go=1` auto-resume exists on
  `/claim/$token`.
- Workspace roles offered to people: owner (Admin), editor (Creator), commenter (Viewer).

## Design

### Model

A new table, not a nullable-email variant of `invitation` (that table is single-use, keyed
on email, and consumed on accept).

```
workspace_join_link
  id           text pk        newId("wjl")
  org_id       text           unique index: one live link per workspace
  role         Role           "commenter" | "editor"   (default editor, decision 2)
  token        text           unique index; plaintext at rest (decision 1)
  created_by   text nullable  user id
  created_at   text
  expires_at   text           created_at + 30 days
  join_count   integer        default 0
```

Schema lands in `schema.ts`, `pg-schema.ts`, both `TABLES` lists, `parity.ts`, then
`pnpm --filter @derive/db gen:d1-schema` regenerates `deploy/d1-schema.sql`. Hosted
derive.to runs Postgres only; the boot DDL creates the table on deploy (confirmed with
Anir 2026-09-08, verify on the PR preview deploy).

### Store contract

`getJoinLink(orgId)`, `getJoinLinkById(id)`, `getJoinLinkByToken(token)`,
`replaceJoinLink(l)` (delete-then-insert: create and rotate are one call),
`deleteJoinLink(orgId)`, `bumpJoinCount(id)`.

### API (`apps/api/src/routes/workspace-join.ts`)

| Route | Auth | Behaviour |
| --- | --- | --- |
| `GET /v1/workspace/join-link` | manage | Current link or 404. Never a 500 for "none". |
| `POST /v1/workspace/join-link` | manage | Body `{role}`: commenter or editor, editor when omitted; owner is 400. Creates or rotates. Returns the fresh url. No seat gate here. |
| `DELETE /v1/workspace/join-link` | manage | Revoke. 204. |
| `GET /v1/join/{token}` | none | Preview: workspace, role, inviter, expires_at. Arms signup admission with kind `join`. 404 unknown or revoked, 410 `join_link_expired`. |
| `POST /v1/join/{token}` | user | Already a member: 200 `{already_member: true}`, role untouched. Otherwise `seatGrantGate` for editor links (402), then `setMembership`, clear any pending email invite for the joiner's address, `syncSeats`, `bumpJoinCount`. Does not switch the active workspace; the client does. |

Token: `mintToken("dkj")`, URL `${baseUrl}/join/${token}`.

### Web

- Members section: a "Join link" card above pending invitations. No link: role select with
  Creator selected by default (Viewer one click away) and "Create link". Under the
  select, always visible and plan-aware:
  - Free: "Free covers 3 Creators. A 4th moves you to Team, where every Creator and Admin is $15/mo."
  - Team: "Every Creator and Admin is $15/mo. Each join adds one."
  - Billing off (beta): "Billing is off on this instance, so Creators stay free."
  On a subscribed workspace, creating a Creator link goes through the seat-confirm
  dialog: "Create a Creator link? Everyone who joins becomes a Creator and adds $15/mo to
  {workspace}'s bill. Revoke the link any time." Active link: the URL with Copy, the role,
  "expires in N days", "N joined", "Each join adds a Creator at $15/mo." for a Creator
  link, Regenerate, Revoke behind a confirm.
- Join page `routes/join.$token.tsx`: reuses the invitation panel. Signed out: "Sign in to
  join" with `return_to=/join/{token}?go=1`; the page auto-joins on `go=1` after login.
  Expired: "This link has expired. Ask the person who sent it for a new one." Seat limit:
  "{workspace} has no Creator seats left. Ask {inviter} for a Viewer link or an upgrade."
- Billing is licensed on grant: once on Team every Creator and Admin seat bills, not only
  the ones past three. The copy must never imply otherwise. Prices come from
  `unitPrice(tier, interval)`, so Business and annual read correctly.

### Permissions and safety

- Only owners create, rotate, revoke. The link grants commenter or editor, never owner.
- The seat gate runs at join, identical to the invite gate; `syncSeats` updates Stripe on
  every join.
- Anonymous users cannot join. Signup admission through the arming cookie keeps
  invite-only deployments closed to everyone except link holders.
- Fixed 30-day expiry. Rotation kills the old link. Revocation is immediate.
- A plain visit to `/join/{token}` never joins anyone; only a click (or the `go=1` flag
  that our own sign-in button sets) does.

### Decisions

1. Token at rest: plaintext (Connor, 2026-09-10). Threat model in the `JoinLinkRecord`
   comment (`packages/core/src/ports.ts`); the schema comments point there.
2. Default role: Creator (Connor, 2026-09-10). An activated team means members published,
   and Viewers cannot publish. The price is stated before the link exists.
3. Auto-resume after sign-in: `?go=1` on the join page only. Invites unchanged.

### Out of scope

Domain auto-join (follow-up), several links per workspace, per-link expiry choice, links
into a collection, changing a link's role in place (rotate instead).
