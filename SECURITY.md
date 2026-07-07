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
  (set it for headless CI/agent automation). General access (the shared link) can grant a
  reacher view or comment; the comment grant only lifts a *signed-in* reacher to commenter,
  never an anonymous one. The effective capability by who's asking:

  | General access (the link)     | Anonymous (no account)         | Signed in via link (no explicit grant) | Member / explicit share        |
  |--------------------------------|--------------------------------|----------------------------------------|--------------------------------|
  | Anyone with link, **view**     | View                           | View                                   | Their role (at least view)     |
  | Anyone with link, **comment**  | View only (sign in to comment) | View + comment                         | Their role (at least comment)  |
  | Public (listed), view/comment  | same as link row               | same as link row                       | Their role                     |
  | Password, view/comment         | Unlock, then as above          | Unlock, then as above                  | Their role (no password needed)|
  | Workspace (org)                | No access                      | No access                              | Their role (members only)      |
  | Private (invite-only) — default | No access                     | No access                              | Explicit share only — workspace role grants nothing |
  | Unlisted (workspace, link only), view/comment | No access       | No access (non-members)                | Members with the link: view/comment; explicit shares: their role |

  A signed-in human's publish defaults to **private**: only the publisher (written
  as the owner-member at creation) can see a fresh artifact. AGENT-credentialed
  publishes — the /mcp server, and any /v1 publish carrying a registered agent
  token or OAuth bearer (the CLI and stdio-shim paths) — default to **unlisted**,
  a workspace setting (`defaultAgentVisibility`): hidden from every listing, but a
  workspace member with the link gets the workspace's default general role. It's
  the same who × listed-or-link-only pairing as public/link, one tier down: a
  workspace audience that stays out of the shared library until surfaced. Reach is
  only ever workspace-inward of private's explicit-share-only model plus the link
  requirement, and the setting restores private-by-default in one click. Private
  and unlisted artifacts never appear in workspace listings, profile work lists,
  or the People-visible surfaces (the library's "Created by me" filter still finds
  your own regardless of visibility). Widening (workspace, link, public) is always
  an explicit act. GitHub-mirror syncs publish workspace-visible — a mirrored repo
  is a workspace resource, not a personal draft.

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
