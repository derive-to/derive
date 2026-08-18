# Technical plan example

A plan is worth keeping at one URL because it changes. This example is written to be
revised: the decision is stated plainly, the reasoning that supports it is separable from
the decision itself, and there is an explicit list of things that would overturn it.

The point of publishing it to Derive is not the first version. It is that six weeks later a
reader can see what the plan said, what changed, and why, without anyone maintaining a
changelog by hand.

## Publish it

```bash
derive publish
```

## Then revise it, and mean it

The version message is the part people read later. Write it as the reason for the change,
not a summary of the file.

```bash
# after the load test
derive publish --message "Split the rollout into two phases: the load test showed the index
rebuild holding a lock for nine minutes, which would block the renewal sweep behind it."

# after the retry question is settled
derive publish --message "Failed jobs now wait for a person rather than retrying. Automatic
retry on the invoice export risked duplicate invoices."
```

A good message answers "why is this different from what I read last time". A message like
"update plan" throws away the only record of the reasoning.

## Suggested prompt

> Read the plan and check it against what we actually decided this week. Update the decision,
> the open questions, and the triggers that would change it. Publish a new version with a
> message that says what changed and why. Do not quietly drop an open question: either answer
> it in the plan or say who still owns it.

## What to look at in the live example

Open the version history rather than only the current text. The plan reads differently when
you can see that phase two was originally the same change as phase one, and what evidence
split it.
