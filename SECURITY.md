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

- **Anonymous callers are always read-only.** They may view public/link artifacts
  and join live presence (a server-assigned handle + cursor) — nothing else. There is
  no "open" mode that elevates anonymous callers to owners. To write, a caller must
  sign in (Better Auth is always available, even zero-config) or present a static
  `DOCK_TOKEN`; set `DOCK_TOKEN` for headless CI/agent automation.
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
