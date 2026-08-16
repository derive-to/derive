# A durable home for agent-made work

> Official Derive example. This is a product-decision template, not independent market
> research or a customer endorsement.

## Decision

Keep agent output in a dedicated artifact when someone will need to find, understand, share,
or update the result after the generating conversation ends. Keep disposable exploration in
chat.

## Evaluation criteria

| Criterion | Question | Evidence to collect |
| --- | --- | --- |
| Fidelity | Can a reader inspect the real rendered output? | Compare the artifact with its intended destination. |
| Findability | Can someone locate the current result without knowing the original chat? | Ask a new teammate to find it from the workspace library. |
| Continuity | Do later versions keep the same URL and readable history? | Publish a focused update and inspect both versions. |
| Collaboration | Can comments and edits stay attached to the work? | Comment on exact text, revise it, and inspect re-anchoring. |
| Portability | Can the team export source and run the system itself? | Perform an export, restore, and self-host smoke test. |

## Findings

Chat is fastest while one person is exploring with one agent. Its weakness appears later:
the result, reasoning, feedback, and current state are easily split across messages and
tools. A repository is an excellent source of truth for code, but often asks a client,
operator, or subject-matter expert to evaluate a diff instead of the rendered deliverable.

A dedicated artifact earns its place when it preserves a useful result and makes the next
interaction easier: find it, share it, comment on it, edit it, or publish a later version.
Formal review is valuable for consequential decisions, but it is not the test every artifact
must pass.

## Recommendation boundary

Do not introduce another system for disposable scratch work or output nobody expects to use
again. Use it for plans, reports, pages, decks, demos, and recurring documents whose current
state or history will matter later.

## Reading checklist

- Are the alternatives described fairly, including when they are the better choice?
- Does every conclusion follow from an observable criterion?
- Are security and self-hosting assertions tested rather than assumed?
- Are the recommendation, uncertainty, and unanswered questions easy to find?
