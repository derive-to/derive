# Choosing a review surface for agent-made work

> Official Derive example. This is a product-decision template, not independent market
> research or a customer endorsement.

## Decision

Use a dedicated review surface when an agent's output will be relied on by someone who was
not present in the generating conversation, and the team must preserve why a version was
accepted. Keep lightweight, disposable work in chat.

## Evaluation criteria

| Criterion | Question | Evidence to collect |
| --- | --- | --- |
| Fidelity | Can reviewers inspect the real rendered output? | Compare the review view with the final destination. |
| Accountability | Is every mutation tied to an identity and permission? | Inspect access rules and the audit trail. |
| Revision continuity | Does feedback survive focused rewrites? | Comment on exact text, revise it, and inspect re-anchoring. |
| Decision closure | Can a named person approve a specific version? | Complete a review round and inspect its history. |
| Portability | Can the team export source and run the system itself? | Perform an export, restore, and self-host smoke test. |

## Findings

Chat is fastest while one person is exploring with one agent. Its weakness appears at the
handoff: the work, reasoning, feedback, and final decision are easily split across messages
and tools. A repository is an excellent source-of-truth for code, but often forces a client,
operator, or subject-matter reviewer to evaluate a diff instead of the rendered deliverable.

A dedicated artifact review surface earns its place only if it closes the complete loop:
publish the actual work, collect attributable feedback, revise without changing the shared
URL, and record approval of a named version. Publishing alone is not enough.

## Recommendation boundary

Do not introduce another system for private scratch work, one-person tasks, or output that
will be discarded immediately. Use it for plans, reports, pages, decks, and recurring
documents whose review history or approval will matter later.

## Review checklist

- Are the alternatives described fairly, including when they are the better choice?
- Does every conclusion follow from an observable criterion?
- Are security and self-hosting assertions tested rather than assumed?
- Is the final approver named, and are unresolved comments visible before approval?
