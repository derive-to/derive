# Governance and maintainers

Derive is maintained by the Derive organization. Maintainers are responsible for the
technical direction, release quality, security response, community moderation, and the
long-term cost of accepted changes.

## Current maintainers

- [@an1va](https://github.com/an1va)
- [@cpellan561](https://github.com/cpellan561)
- [@oz6un](https://github.com/oz6un)
- [@robert-moore](https://github.com/robert-moore)

GitHub repository permissions are the authoritative record if this list and access ever
drift. A change to the maintainer list should be reviewed by an existing maintainer.

## How decisions are made

Small, reversible implementation choices are resolved in pull-request review. A change
should begin with an issue or Discussion when it introduces a public capability, changes a
protocol or permission boundary, adds an operational dependency, changes storage or data
retention, or creates a maintenance burden that is not obvious from the diff.

Maintainers seek clear technical agreement rather than vote counting. When reasonable
options remain, the directly responsible maintainer records the decision and its tradeoffs.
Security fixes may follow a private process until coordinated disclosure is safe.

## Review standard

- Reviews are requested deliberately. Routine dependency updates do not notify every
  maintainer merely because the bot changed a broadly owned file.
- A maintainer does not approve their own pull request. Repository administrators may use
  GitHub's pull-request-only bypass when another maintainer is unavailable. It preserves the
  pull request and audit trail and must only be used after the required checks pass.
- Required checks must pass; a review does not waive the deterministic gate.
- Review covers the problem, permissions, failure modes, tests, operations, documentation,
  and compatibility—not only whether the patch compiles.
- Generated or AI-assisted code is reviewed to the same standard as hand-written code. The
  contributor remains responsible for understanding and explaining it.
- A maintainer may close a technically valid contribution when its long-term cost or product
  direction is not justified. The reason should be stated plainly.

## Becoming a maintainer

Maintainer access follows demonstrated judgment over time: useful reviews, reliable
follow-through, respect for security and users, and ownership after a change ships. It is
not granted solely by contribution count. An existing maintainer proposes the change and
another maintainer approves it.

For support, contribution, conduct, and vulnerability-reporting channels, see
[support](SUPPORT.md), [contributing](../CONTRIBUTING.md),
[code of conduct](../CODE_OF_CONDUCT.md), and [security](../SECURITY.md) policies.
