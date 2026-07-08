# Security Policy

## Reporting a vulnerability

Please report security issues privately — do not open a public issue for anything
exploitable.

- Use GitHub's [private vulnerability reporting](https://github.com/derive-to/derive/security/advisories/new), or
- Email **security@derive.to** with steps to reproduce and the impact.

We aim to acknowledge within 3 business days and to ship a fix or mitigation as fast
as the severity warrants. We'll credit you in the release notes unless you'd rather
stay anonymous.

## Supported versions

Derive is pre-1.0 and moves quickly. Security fixes land on `main` and the latest
release; please run a recent build.

## Hardening notes for self-hosters

Derive ships safe defaults, but a few choices matter for an internet-facing deploy:

- **Anonymous callers are always read-only.** This is the load-bearing access
  invariant: an anonymous (no-account) caller is never more than a viewer. Anything past
  view (comment, propose, publish, share, manage) requires an authenticated identity, so
  there is no "open" mode that elevates an anonymous caller. To write, a caller signs in
  (Better Auth is always available, even zero-config) or presents a static `DERIVE_TOKEN`
  (set it for headless CI/agent automation).

  Access is two independent axes (round 4, docs/plans/link-grant.md). **Where it's
  listed** (`visibility`: private / org / public) governs discoverability — feeds,
  libraries, and whether workspace membership alone grants standing (it does at
  org/public, never at private). **What the link grants** (`link_audience` ×
  `link_role`) governs reach: who the bare URL works for (`org` = signed-in members
  of the artifact's workspace, `public` = anyone) and what it confers (`none` =
  inert, invite-only; viewer / commenter / editor). Writing grants only lift a
  *signed-in* holder the audience admits — never an anonymous one. The effective
  capability by who's asking, for any visibility:

  | Link grant                | Anonymous (no account) | Signed in outside the workspace | Workspace member       | Explicit share          |
  |---------------------------|------------------------|---------------------------------|------------------------|-------------------------|
  | Inert (`none`) — sealed   | No access              | No access                       | Their standing¹        | Their share role        |
  | Workspace · view/comment/edit | No access          | No access                       | max(standing¹, grant)  | max(share, grant²)      |
  | Anyone · view             | View                   | View                            | max(standing¹, view)   | max(share, view)        |
  | Anyone · comment          | View (sign in to comment) | View + comment               | max(standing¹, comment)| max(share, comment)     |
  | Anyone · edit             | View (sign in to edit) | Editor                          | max(standing¹, edit)   | max(share, edit)        |

  ¹ Standing = membership role at org/public visibility; NOTHING at private (a
  workspace owner still cannot open a teammate's sealed private draft by role
  alone). ² A shared-with outsider is not in a workspace audience; their share
  role alone applies.

  One coherence rule: a **public listing requires a public link at viewer or
  above** — "public means the link works, full stop"; listed-but-unopenable
  states are unrepresentable. One modifier: a password on a public listing gates
  the link floor until unlocked (members and explicit shares never need it), and
  a locked artifact's bytes are never shared-cacheable.

  Every publish defaults to a **private listing with a Workspace · can-comment
  link**: nothing is listed anywhere, teammates handed the URL can open and
  comment, and no one outside the workspace can reach it. That includes AGENT
  publishes — the /mcp server, and any /v1 publish carrying a registered agent
  token or OAuth bearer (the CLI and stdio-shim paths) — where the listing is
  governed by `defaultAgentVisibility` and the link pair by the same workspace
  defaults (`defaultLinkAudience` · `defaultLinkRole`; a bare public publish gets
  the classic public · viewer pair, never the workspace role). Existing artifacts
  are never retroactively widened by changing a default. Private artifacts never
  appear in another viewer's listings, profiles, or People surfaces (your own
  library and the "Created by me" filter always find your own). Widening —
  listing wider, or opening the link to Anyone — is always an explicit act.
  GitHub-mirror syncs publish workspace-visible — a mirrored repo is a workspace
  resource, not a personal draft.

  `packages/core/src/permissions.ts` (`effectiveRole`) is the single source of truth for
  this table, enforced on every request by the one `can()` gate and surfaced in the UI so
  no comment affordance is shown to someone who can't comment.
- **Set `DERIVE_AUTH_SECRET`.** Generated and persisted automatically for single-node
  self-host; you must set it explicitly for multi-instance deployments so every node
  shares the same session-signing secret.
- **Serve artifact bytes from a separate origin.** Set `DERIVE_SANDBOX_URL` to a
  different registrable domain so untrusted artifact HTML can never reach the app's
  cookie origin. Single-origin deploys rely on the iframe `sandbox` attribute alone.
- **Webhook URLs are SSRF-filtered** (private, loopback, and cloud-metadata
  addresses are rejected) and generic payloads are signed with `X-Derive-Signature`.
- **Rate limits + storage quotas** are available (`DERIVE_RATE_LIMIT`,
  `DERIVE_MAX_BYTES`, `DERIVE_MAX_ARTIFACTS`, `DERIVE_PUBLISH_RATE`, `DERIVE_COMMENT_RATE`) —
  enable them on shared instances.
- **Breached-password check** rejects passwords found in the Have I Been Pwned corpus at
  sign-up / reset / change, using k-anonymity (only a SHA-1 prefix is sent, never the
  password). It **fails open** — if the HIBP API is unreachable (e.g. an air-gapped host)
  account creation is never blocked. Disable with `DERIVE_BREACH_CHECK=false`.
- **Account deletion is a hard delete with anonymization.** When a user deletes their
  account, Better Auth removes the account and its sessions, passkeys, and 2FA, then the
  Derive cascade (`MetaStore.deleteUserData`) drops their memberships, follows, favorites,
  and notifications and **anonymizes** their authorship — `author_id` on artifacts,
  versions, comments, and proposals is nulled so co-authored threads survive intact rather
  than being destroyed with the account. Their personal workspace is dropped; artifact
  bytes are not hard-deleted (orphaned + anonymized, a GC concern). Deletion is **blocked**
  while the user is the sole owner of a workspace that still has other members, so a shared
  workspace can never be stranded without an admin — they must transfer ownership or remove
  the others first.
