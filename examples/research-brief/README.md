# Research brief example

A recommendation is only reviewable if a reader can check the reasoning behind it. This
example separates four things that usually get mixed together: the question, the answer, the
evidence for it, and the conditions that would overturn it.

The sources are real documentation and are linked, so a reader can disagree with the reading
rather than only with the conclusion.

## Publish it

```bash
derive publish
```

## What this example is careful about

**The recommendation is bounded.** It says start with SQLite *while these conditions hold*,
and names the boundaries that flip the answer. An unbounded recommendation cannot be wrong,
which also means it cannot be useful.

**Assumptions are listed as assumptions.** They are the things nobody verified, written where
a reader can challenge one.

**The trigger is a condition, not a date.** "Revisit if concurrent writers appear" survives
contact with a schedule slipping. "Revisit in Q3" does not.

## Suggested prompt

> Check the recommendation against the linked documentation and against how the service is
> actually deployed now. If an assumption has become false, say so plainly and change the
> recommendation rather than adding a caveat. Publish a new version whose message says what
> moved and why.
