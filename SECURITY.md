# Security Policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue for anything
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
  view (comment, publish, share, manage) requires an authenticated identity, so
  there is no "open" mode that elevates an anonymous caller. To write, a caller signs in
  (Better Auth is always available, even zero-config) or presents a static `DERIVE_TOKEN`
  (set it for headless CI/agent automation).

  Access is three independent, single-purpose fields (docs/access-model.md).
  **`workspace_access`** (`none` / `member`): do the artifact's workspace members
  reach it, each at their own SEAT role (owner→manage, editor→edit, commenter→comment)?
  **`link_role`** (`none` / viewer / commenter / editor): what merely holding the
  URL confers on anyone, including people outside the workspace (`none` = no world
  link). **`listed`** (`none` / workspace / public) controls whether it appears in
  the workspace library or the public directory. It grants no access of its own.
  The active workspace is part of the authorization context: workspace seats and
  owner-level artifact/collection grants apply only while the artifact's workspace
  is active. Switching workspaces therefore never carries private ownership along.
  Explicit viewer/commenter/editor shares and world links remain portable; an owner
  may only be assigned to a member of the artifact's workspace.

  Within that context, the effective role is `max(explicit share, workspace seat
  if a member, world link)`; an anonymous holder of a live link is always clamped
  to view. The effective capability by who's asking:

  | Field state                    | Anonymous (no account) | Signed in outside the workspace | Workspace member          | Explicit share          |
  |--------------------------------|------------------------|---------------------------------|---------------------------|-------------------------|
  | workspace_access none, link none | No access            | No access                       | Their portable share only¹ | Their share role       |
  | workspace_access member          | No access            | No access                       | max(seat, share)          | max(seat², share)       |
  | link_role viewer                 | View                 | View                            | max(seat/share, view)     | max(share, view)        |
  | link_role commenter              | View (sign in to comment) | View + comment             | max(seat/share, comment)  | max(share, comment)     |
  | link_role editor                 | View (sign in to edit) | Editor                        | max(seat/share, edit)     | max(share, edit)        |

  ¹ workspace_access=none withholds the seat grant, so a workspace owner cannot
  open a teammate's invite-only draft by role alone. Only an explicit share does.
  Owner grants are not portable shares: they require this workspace to be active.
  ² A shared-with outsider isn't a workspace member, so their seat grant is nil;
  their share role alone applies.

  Two invariants (the only cross-field rules): **`listed=workspace` requires
  `workspace_access=member`** and **`listed=public` requires a `link_role`**. A
  doc can't be listed somewhere it grants no access to. One modifier: a password
  gates the world link until unlocked (members and explicit shares never need it),
  and a locked artifact's bytes are never shared-cacheable.

  Every publish defaults to the **team draft**: `workspace_access=member`,
  `link_role=none`, `listed=none`. Nothing is listed anywhere, and teammates reach it
  at their seat role (so a pasted link opens for the team), and no one outside the
  workspace can reach it. That includes agent publishes from the `/mcp` server and any
  `/v1` publish carrying a registered agent token or OAuth bearer. The CLI and
  stdio-shim paths resolve from the same workspace defaults
  (`defaultWorkspaceAccess` · `defaultLinkRole` · `defaultListed`). Existing
  artifacts are never retroactively widened by changing a default. Invite-only
  artifacts (workspace_access=none, no link) never appear in another viewer's
  listings, profiles, or People surfaces (your own library and the "Created by me"
  filter always find your own). Widening access by granting the workspace, listing wider,
  or opening the link to Anyone is always an explicit act. GitHub-mirror syncs
  publish as workspace-listed because a mirrored repo is a workspace resource, not a
  personal draft.

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
  `DERIVE_MAX_BYTES`, `DERIVE_MAX_ARTIFACTS`, `DERIVE_PUBLISH_RATE`, `DERIVE_COMMENT_RATE`).
  Enable them on shared instances.
- **Breached-password check** rejects passwords found in the Have I Been Pwned corpus at
  sign-up / reset / change, using k-anonymity (only a SHA-1 prefix is sent, never the
  password). It **fails open**: if the HIBP API is unreachable, such as on an air-gapped host,
  account creation is never blocked. Disable with `DERIVE_BREACH_CHECK=false`.
- **Account deletion is a hard delete with anonymization.** When a user deletes their
  account, Better Auth removes the account and its sessions, passkeys, and 2FA, then the
  Derive cascade (`MetaStore.deleteUserData`) drops their memberships, follows, favorites,
  and notifications and **anonymizes** their authorship. `author_id` on artifacts,
  versions, and comments is nulled so co-authored threads survive intact rather
  than being destroyed with the account. Their personal workspace is dropped; artifact
  bytes are not hard-deleted (orphaned + anonymized, a GC concern). Deletion is **blocked**
  while the user is the sole owner of a workspace that still has other members, so a shared
  workspace can never be stranded without an admin. They must transfer ownership or remove
  the others first.
