# Derive workflow examples

These are official, publishable examples of work that benefits from Derive's complete
publish → review → revise → approve loop. They demonstrate the product; they are not
customer work, testimonials, or synthetic case studies presented as real outcomes.

| Example | Live artifact | Review job |
| --- | --- | --- |
| [Launch page source](launch-page/) | [Open artifact](https://derive.to/artifacts/example-launch-page-5cmep9l9) | Review message, evidence, layout, and final release approval |
| [Research brief source](research-brief/) | [Open artifact](https://derive.to/artifacts/example-research-brief-ms66yju2) | Challenge sources and conclusions before a decision |
| [Living status source](living-status/) | [Open artifact](https://derive.to/artifacts/example-living-status-f49k4yvg) | Review changing metrics, risks, owners, and decisions at one URL |

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

## Run the loop

1. Publish the first version and choose the intended link role in Derive.
2. Send the artifact URL to a real reviewer. Viewing may be anonymous; feedback requires
   sign-in so it has an accountable author.
3. Ask a connected agent to call `catch_up`, address every open thread, and publish a
   focused revision.
4. Have the named reviewer approve or send the revision back.
5. Inspect the version and decision history at the same URL.

The useful output of an example is not the page alone. It is the visible record of what
changed, why it changed, and who decided it was ready.
