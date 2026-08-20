# Change review example

When an agent verifies a change, the useful output is not "it works". It is a record another
person can audit: what was claimed, what was actually run, what broke on the way, and what
is still unproven.

This example is written so a reviewer can disagree with it. Every check names its input and
its result, the environment is stated because it changes what the checks are worth, and the
gaps are listed rather than left for someone to discover.

It is a designed page because a verification record is read by someone deciding whether to
merge. The verdict is in the masthead, the environment is a strip you cannot skip, and each
check carries its literal result rather than a tick.

[Open the official live example](https://derive.to/artifacts/csv-importer-what-changed-and-how-it-was-checked-n5k7pgb5).

## Publish it

```bash
derive publish
```

Publishing the verification next to the change gives the reviewer one link that answers "how
do you know?" instead of a screenshot pasted into a thread.

## Suggested prompt

> Verify this change on a deploy preview, not locally. For each behaviour you check, record
> the exact input and the exact result, including the error text. If something breaks while
> you are checking, keep it in the writeup with the cause. End with what you did not cover
> and why, and file anything you found but did not fix.

## The part agents get wrong

Two failure modes are common and both are visible in this example by their absence.

**Reporting the plan as the result.** "Tested with valid and invalid files" is not a result.
The table records what came back, including the literal error string, because that string is
what a user will read.

**Silence about scope.** An agent that checked one 2 MB file should not imply the 200 MB case
works. The "Not covered" section exists so the reviewer knows the shape of the hole rather
than assuming there is none.
