# Derive artifact examples

Six examples of work worth keeping at a durable URL. They are sample material, not customer
work or testimonials, and every one of them says so on its face.

Each example is a shape people actually publish, not a feature demonstration. The point of
each is the second version as much as the first: a plan that changes, a status that moves
backwards when evidence says so, a page whose design is the thing under review.

| Example | Shape | What it is for |
| --- | --- | --- |
| [Technical plan](technical-plan/) | Markdown | A decision and its reasoning, written to be revised. The version history carries what changed and why. |
| [Change review](change-review/) | Markdown | What an agent actually ran to verify a change, including what broke and what is still unproven. |
| [Living status](living-status/) | Styled HTML + facts | The current state of a rollout at one URL, read at a glance, with the numbers readable back as a series. |
| [Research brief](research-brief/) | Markdown | A bounded recommendation with sources a reader can check. |
| [Launch page](launch-page/) | Styled HTML | A designed result kept as the artifact itself, with every claim paired to its limit. |
| [On-call handbook](handbook/) | Multi-page bundle | Several pages as one artifact, one history, one set of permissions. |

## Publish one

Access is omitted from each `derive.json`, so a new copy uses your workspace default rather
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
