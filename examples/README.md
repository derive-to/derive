# Derive artifact examples

These are official, publishable examples of agent-made work worth keeping at a durable URL.
Each shows a different useful shape; none prescribes a required workflow. They demonstrate
the product, but they are not customer work, testimonials, or synthetic case studies
presented as real outcomes.

| Example | Live artifact | What it demonstrates |
| --- | --- | --- |
| [Launch page source](launch-page/) | [Open artifact](https://derive.to/artifacts/example-launch-page-5cmep9l9) | Keep a designed result, not a flattened chat transcript |
| [Research brief source](research-brief/) | [Open artifact](https://derive.to/artifacts/a-durable-home-for-agent-made-work-official-deri-ms66yju2) | Keep sources, uncertainty, and recommendations together |
| [Living status source](living-status/) | [Open artifact](https://derive.to/artifacts/active-agent-work-official-derive-example-f49k4yvg) | Update current work, risks, owners, and decisions at one URL |

## Publish an example

The live links above are viewer-only public artifacts in the official Derive workspace.
Each source directory contains a `derive.json` whose access settings are intentionally omitted,
so publishing inherits the workspace default rather than silently creating a public link.

```bash
derive login
cd examples/launch-page
derive publish
```

After the first publish, the CLI writes the artifact ID to `derive.json`. Do not commit
that instance-specific ID when using these examples as templates.

## Continue the work when useful

1. Publish the first version and choose the intended access in Derive.
2. Keep it private or share the URL with the people who need it.
3. If feedback arrives, ask a connected agent to call `catch_up`, address the relevant
   threads, and publish a focused revision.
4. Use formal approval only when the work needs a named decision.
5. Return later to inspect or update the same artifact and its history.

The useful output is the page and its continuity: the current result, earlier versions,
authorship, and any conversation or decision that belongs with it.
