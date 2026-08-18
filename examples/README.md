# Derive artifact examples

Six examples of work worth keeping at a durable URL. They are sample material, not customer
work or testimonials, and every one of them says so on its face.

Each example is a shape people actually publish, not a feature demonstration. The point of
each is the second version as much as the first: a plan that changes, a status that moves
backwards when evidence says so, a page whose design is the thing under review.

Most of them are styled HTML, because that is what substantial work looks like once it is
worth keeping. Markdown is here too, for the case it is genuinely best at: a short document
that is all prose and sources.

| Example | Shape | Live | What it is for |
| --- | --- | --- | --- |
| [Technical plan](technical-plan/) | Styled HTML | [Open](https://derive.to/artifacts/moving-scheduled-jobs-off-the-app-server-oukskpia) | A decision and its reasoning, written to be revised. The version history carries what changed and why. |
| [Change review](change-review/) | Styled HTML | [Open](https://derive.to/artifacts/csv-importer-what-changed-and-how-it-was-checked-n5k7pgb5) | What an agent actually ran to verify a change, including what broke and what is still unproven. |
| [Living status](living-status/) | Styled HTML + facts | [Open](https://derive.to/artifacts/customer-import-rollout-current-status-f49k4yvg) | The current state of a rollout at one URL, read at a glance, with the numbers readable back as a series. |
| [Research brief](research-brief/) | Markdown | [Open](https://derive.to/artifacts/sqlite-or-postgresql-for-a-small-internal-servic-ms66yju2) | A bounded recommendation with sources a reader can check. |
| [Launch page](launch-page/) | Styled HTML | [Open](https://derive.to/artifacts/example-launch-page-5cmep9l9) | A designed result kept as the artifact itself, with every claim paired to its limit. |
| [On-call handbook](handbook/) | Multi-page bundle | [Open](https://derive.to/artifacts/on-call-handbook-a-derive-bundle-example-7eq9ri5j) | Several pages as one artifact, one history, one set of permissions. |

## Publish one

The live links are public, viewer-only artifacts in the official Derive workspace. Access is
omitted from each `derive.json`, so a copy you publish uses your workspace default rather
than inheriting a decision from this repository.

```bash
derive login
cd examples/technical-plan
derive publish
```

The CLI adds the artifact ID to `derive.json` after the first publish. Leave that ID out when
you copy an example into another project.

## What the examples are trying to teach

**Publish the thing, not a description of it.** A launch page flattened into prose loses the
hierarchy, which is most of what there was to review.

**Write version messages worth reading later.** "Update plan" throws away the only record of
why the plan changed. Every example's README shows the message it would actually use.

**Say what is not covered.** Several examples end with an explicit list of what is untested,
unproven, or out of scope. Work that only lists its strengths cannot be reviewed, because
there is nothing in it a reader can check and disagree with.

**Let a document move backwards.** The living status records a test moving from done back to
open, because that is what happened. A status that only advances is being performed, not
maintained.
