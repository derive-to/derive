# Derive artifact examples

These official examples show useful work at a durable URL. They are sample material, not
customer work or testimonials.

| Example | Live artifact | What it demonstrates |
| --- | --- | --- |
| [Launch page source](launch-page/) | [Open artifact](https://derive.to/artifacts/example-launch-page-5cmep9l9) | Keep a designed result, not a flattened chat transcript |
| [Research brief source](research-brief/) | [Open artifact](https://derive.to/artifacts/sqlite-or-postgresql-for-a-small-internal-servic-ms66yju2) | Compare options with sources and a bounded recommendation |
| [Living status source](living-status/) | [Open artifact](https://derive.to/artifacts/customer-import-rollout-current-status-f49k4yvg) | Keep a rollout's current state, risks, and next actions in one place |

## Publish an example

The live links are public, viewer-only artifacts in the official Derive workspace. Access is
omitted from each `derive.json`, so a new copy uses your workspace default.

```bash
derive login
cd examples/launch-page
derive publish
```

The CLI adds the artifact ID to `derive.json` after the first publish. Leave that ID out when
you copy an example into another project.
