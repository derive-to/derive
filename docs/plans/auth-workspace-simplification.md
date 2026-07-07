# Simplifying auth, workspaces, and sharing before launch

Status: proposal, not decided. Written for team review ahead of launch.

We're about to put this in front of new users, and the auth/workspace/sharing
surface feels more complicated than it needs to be. This doc is a diagnosis and
a set of concrete proposals, not a finished spec — the point is to agree on
direction, then break out implementation plans for whichever pieces we take on
before launch.

## The good news: the identity model underneath is already right

Today, Derive is **one global account per email, able to belong to any number
of workspaces** — `user.email` is globally unique, and workspace membership is
a `(workspace, user) → role` row with no cap on how many workspaces one person
can belong to.

That's the same model Slack, Notion, and GitHub organizations use, and it's the
correct one. The alternative — a separate account per company, the way Google
Accounts work (`alice@gmail.com` and `alice@churnkey.co` as two unrelated
identities you switch between with an avatar picker) — isn't a design people
actually like. It's a historical accident (a Google Account *is* a mailbox),
and the pain it causes (incognito windows, "which account is this doc under,"
no shared history between your personal and work identity) is exactly the kind
of thing people complain about, not something to copy.

**So: someone working at two companies should have one Derive account with two
workspace memberships, not two logins.** We don't need to rebuild this part —
it's already correct. The complexity people are feeling is coming from three
specific seams in how it's surfaced, not from the underlying shape.

## Where the complexity actually comes from

### 1. The personal workspace pretends to be a "workspace," invisibly

Every signup silently provisions a workspace (internally `ws_p_<userId>`,
named `"X's Workspace"`) the first time any workspace-scoped call needs one —
not at signup, not as a choice. It's real plumbing (every artifact needs a
workspace to belong to), but the moment a user creates a *second*, real team
workspace, the UI starts showing both with identical language: a switcher, a
"Workspace" label, "workspace settings." The user never chose the first one
and has no mental model for why it exists or how it relates to the one they
did choose.

Compare:

- **GitHub** doesn't wrap your personal account in an invisible "personal
  org." Repos live at `github.com/rob/repo`. The word "organization" only
  enters your vocabulary when you deliberately create one.
- **Notion** does wrap everyone in a workspace, but it asks explicitly at
  signup — *"Just for you, or with a team?"* — so the wrapper is a decision
  you remember making, not plumbing you discover later.
- **Slack** workspaces are always named and visible, but nobody has an
  invisible "personal Slack."

Derive currently does neither: it auto-creates the wrapper *and* later
surfaces "workspace" language for it as if it were a deliberate choice.

**Agreed direction:** for a workspace with exactly one member, drop the word
"workspace" from the UI entirely — call it "Your Library," no switcher, no
"workspace settings," just "Account." The switcher and the term "workspace"
only appear once a second member exists, on either side (yours or one you've
joined). At signup, replace the silent auto-provision with an explicit fork:
**"Personal account" or "Create a company account"** (Rob: happy to ask this
at signup if it earns its keep setting up the right semantics — same idea as
Notion's "just for you / with a team," worded around what it actually
provisions here). Same underlying row gets created either way, but now it's a
decision the user remembers making, and we can use the answer to set sensible
defaults (e.g. a company account can prompt for teammates' emails right there,
a personal account skips that entirely).

### 2. "Draft" isn't a lifecycle state — it's an unnamed feed/listing axis

Revised after discussion. My first pass treated "Draft" as a mislabeled
lifecycle status and suggested peeling it off into a separate review-status
boolean. Rob's pushback is right: we don't want to add a new concept here, and
"unlisted within the workspace" is actually a real, already-useful thing he
wants to keep — not something to replace with new complexity. Rethinking it in
the broader context of the visibility ladder, not in isolation:

Artifact visibility today has six levels: `private`, `org`, `unlisted`,
`link`, `public`, `password`. Look at the two ends of that ladder that are
already uncontroversial:

- **`public`** = anyone can open it, **and** it's listed/searchable.
- **`link`** = anyone can open it, but it's **not** listed anywhere — you only
  get there with the URL.

That's one audience tier (`anyone`) crossed with one independent axis: *is
this surfaced in a shared feed, or only reachable if someone hands you the
link.* Nobody finds that pairing confusing — it's the YouTube
public/unlisted/private model, and it's intuitive.

`org` and `unlisted` are the exact same pairing, one tier down, at
`workspace` instead of `anyone`:

- **`org`** = any workspace member can open it, **and** it shows up in the
  shared workspace library.
- **`unlisted`** = any workspace member can open it if they have the link,
  but it does **not** show up in the shared workspace library.

That's not a lifecycle state at all — it's "keep this out of the team feed
until I decide to surface it," which is a completely reasonable thing to want
(a scratch doc, an agent's output you haven't looked at yet, something you're
sharing with one person by link without broadcasting it to the whole
workspace). The reason it currently *reads* as a lifecycle/"draft" concept is
that we only applied the listed/unlisted split at the `anyone` tier and gave
it a real name there (`public` vs `link`), but at the `workspace` tier we
never named the same split — we called the unlisted variant "Draft" instead,
which drags in an unrelated WIP-vs-finished connotation nothing else in the
product supports (there's no `status` field; every artifact is fully live the
instant it's written).

So this is a naming/consistency problem, not a missing-feature problem — and
the fix is to stop treating it as a flat 6-item ladder and present it as what
it already structurally is: two real audience tiers (`workspace`, `anyone`),
each with an independent "shown in the library feed?" toggle, plus `private`
(explicit members only, no feed question applies) and `password` (a lock on
top of the `anyone` tier). No new fields, no boolean, nothing added — just
naming the axis that `public`/`link` already prove works, and applying it
consistently to the `workspace` tier instead of borrowing the word "Draft"
for it.

**Proposal:** keep `private` / `org` / `unlisted` / `link` / `public` /
`password` exactly as they are underneath. In the UI, present visibility as
two dimensions — *who* (Private / Workspace / Anyone) and, for Workspace and
Anyone, *listed in the library or link-only* — rather than one flat ladder
with a mislabeled rung. Retire "Draft" as a name; call the workspace/link-only
state something like "Workspace — link only" or "Hidden from library" so it
reads as the same kind of choice as `public` vs `link`, not as a different
kind of thing.

**Consequence: retire the Drafts tab.** Today the library has a dedicated
"Drafts" tab that's just a filter for `visibility === "unlisted"` — a
special-cased top-level nav item for one visibility value. Once "unlisted"
stops being a distinct lifecycle concept and becomes one setting among
several on the same ladder, it doesn't deserve its own tab any more than
"link" or "password" do. Replace it with a small set of generic filters that
apply across all content, the way Google Drive (My Drive / Shared with me) or
GitHub (all repos / owned by me) do it:

- **Everything** — everything you have access to
- **Created by me**
- **Shared with me** — explicit shares that aren't yours

Visibility (workspace/private/link-only/etc.) becomes a facet you can filter
by within any of those, not a top-level tab — so "show me the stuff that's
workspace-only and link-only" is still one click away, it's just not a
first-class nav item competing with "who owns this."

### 3. CLI/MCP auth has no "who am I," and can't hold two workspace logins at once

**Already in flight** — Anir has a PR up for this. Flagging the underlying
problem here for context, not as an open proposal: `derive login` stores
exactly one token per server with no workspace field, so working across two
workspaces on the same machine today means destructively re-logging-in or
juggling `--token`/env vars by hand, with no `whoami` to answer "which
workspace am I authenticated as right now." Anir's PR is the place to hash out
the actual shape (credential keying, `whoami`, profile switching) — no need to
duplicate that discussion here.

## A bug worth fixing regardless of any of the above

Independent of this whole discussion: accepting a workspace invite never
checks that the accepting account's email matches the invited email. Anyone
holding a valid, unexpired invite token can accept it while signed into *any*
Derive account, including one that has nothing to do with the invited address.
This should get fixed on its own before launch, not bundled into the redesign.

## Suggested sequencing

1. **Now, cheap, high leverage:** fix the invite email-match gap; re-present
   the visibility ladder as (who) × (listed in library or link-only) and
   retire "Draft" as a name; replace the Drafts tab with generic
   Everything/Created by me/Shared with me filters — no schema change, just
   UI grouping and copy.
2. **Before launch:** hide "workspace" language for single-member workspaces;
   add the explicit "Personal / Create a company account" fork at signup.
3. **Already in flight:** CLI/MCP `whoami` and multi-workspace credential
   handling — see PR #308.

## Decisions (2026-07-07, Rob — supersedes the open questions below)

Reviewed with the round-1 implementation (PR #314) in hand. Outcomes:

- **Identity model confirmed**: single account, many memberships. Not
  revisiting. Multi-email per account is a post-launch follow-up.
- **Two-axis presentation confirmed as the destination**, and the dropdown
  gets real grouping now (separator-chunked pairs), not just relabeled rows.
  The `link` rung is renamed **"Public — link only"** so the two pairs read
  as the same axis (Workspace / Workspace — link only · Public / Public —
  link only). Password stays a sixth rung for now; folding it into a
  checkbox on the link rungs is a later change.
- **The signup fork is cut.** No "Personal / company account" question at
  signup or in `/welcome` — the question is asked before the user can answer
  it, and its failure mode (a team-of-one workspace next to the invisible
  personal one, switcher on day zero) recreates the ghost-workspace problem.
  Instead, **workspace-at-first-need**: solo users get a collapsed share
  ladder with a "create a workspace" hint where the team rungs would be;
  create-workspace becomes one flow (name + optional invites); "New
  workspace" is reachable from the user pod; the personal workspace is
  labeled **"Personal"** and pinned once a switcher exists. `/welcome` gets
  one non-branching pointer line. The eventual growth mechanism is domain
  discovery ("3 people from churnkey.co are already on Derive"), not
  self-report.
- **"Created by me" keys on the owner member row**, not the `author_id`
  denorm (which republish clobbers — including to NULL on token publishes).
  Google Drive's "Owned by me" semantics.
- **"Everything" reverts to "All artifacts"** — don't name the one feed that
  hides link-only work "Everything."
- The invite email-mismatch fix ships in the same PR (#314) as a
  surface-the-mismatch flow, per the phase-0 spec in the implementation doc.

## Open questions for the team

- Does "Workspace — link only" (or similar naming) read clearly once it's
  grouped with `public`/`link` under one "listed vs. link-only" axis, or does
  it need a different word entirely?
- Is the signup fork ("Personal" vs "Create a company account") worth the
  extra screen, or should we infer it from whether an invite is pending?
- Any objection to workspace identity staying single-account-many-memberships,
  vs. revisiting that shape entirely?
