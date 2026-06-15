# Security Policy

## Reporting a vulnerability

Please report security issues privately — do not open a public issue for anything
exploitable.

- Use GitHub's [private vulnerability reporting](https://github.com/Niftory/dock.build/security/advisories/new), or
- Email **security@dock.build** with steps to reproduce and the impact.

We aim to acknowledge within 3 business days and to ship a fix or mitigation as fast
as the severity warrants. We'll credit you in the release notes unless you'd rather
stay anonymous.

## Supported versions

Dock is pre-1.0 and moves quickly. Security fixes land on `main` and the latest
release; please run a recent build.

## Hardening notes for self-hosters

Dock ships safe defaults, but a few choices matter for an internet-facing deploy:

- **Anonymous callers are always read-only.** This is the load-bearing access
  invariant: an anonymous (no-account) caller is never more than a viewer. Anything past
  view (comment, propose, publish, share, manage) requires an authenticated identity, so
  there is no "open" mode that elevates an anonymous caller. To write, a caller signs in
  (Better Auth is always available, even zero-config) or presents a static `DOCK_TOKEN`
  (set it for headless CI/agent automation). General access (the shared link) can grant a
  reacher view or comment; the comment grant only lifts a *signed-in* reacher to commenter,
  never an anonymous one. The effective capability by who's asking:

  | General access (the link)     | Anonymous (no account)         | Signed in via link (no explicit grant) | Member / explicit share        |
  |--------------------------------|--------------------------------|----------------------------------------|--------------------------------|
  | Anyone with link, **view**     | View                           | View                                   | Their role (at least view)     |
  | Anyone with link, **comment**  | View only (sign in to comment) | View + comment                         | Their role (at least comment)  |
  | Public (listed), view/comment  | same as link row               | same as link row                       | Their role                     |
  | Password, view/comment         | Unlock, then as above          | Unlock, then as above                  | Their role (no password needed)|
  | Workspace only (org)           | No access                      | No access                              | Their role (members only)      |

  `packages/core/src/permissions.ts` (`effectiveRole`) is the single source of truth for
  this table, enforced on every request by the one `can()` gate and surfaced in the UI so
  no comment affordance is shown to someone who can't comment.
- **Set `DOCK_AUTH_SECRET`.** Generated and persisted automatically for single-node
  self-host; you must set it explicitly for multi-instance deployments so every node
  shares the same session-signing secret.
- **Serve artifact bytes from a separate origin.** Set `DOCK_SANDBOX_URL` to a
  different registrable domain so untrusted artifact HTML can never reach the app's
  cookie origin. Single-origin deploys rely on the iframe `sandbox` attribute alone.
- **Webhook URLs are SSRF-filtered** (private, loopback, and cloud-metadata
  addresses are rejected) and generic payloads are signed with `X-Dock-Signature`.
- **Rate limits + storage quotas** are available (`DOCK_RATE_LIMIT`,
  `DOCK_MAX_BYTES`, `DOCK_MAX_ARTIFACTS`, `DOCK_PUBLISH_RATE`, `DOCK_COMMENT_RATE`) —
  enable them on shared instances.
