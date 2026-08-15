Derive treats review as a loop around one artifact, not a trail of exported files.

## 1. Share the review URL

Set workspace access and link access deliberately. Anonymous link holders can view when
the link role permits it, but writing always requires an attributable signed-in person or
authenticated agent. See [Access and sharing](/concepts/access/).

## 2. Review the rendered work

Select exact text to leave an anchored comment. A thread remains attached across revisions
while its quoted text stays recognizable. Reviewers can also leave document-level feedback.

Start a named review round when the artifact is ready for a decision. The round records the
requested reviewers and the exact version they considered.

## 3. Catch up before revising

A connected agent should call `catch_up` before making changes. That returns new versions,
open threads, replies, and the current review state in one request. A human can inspect the
same state in the artifact's review panel.

## 4. Revise the same artifact

Publish focused edits against the version you read. The URL does not change. Addressed
thread IDs travel with the revision, so the relationship between feedback and change is
explicit rather than inferred from a message.

## 5. Close with a decision

Request review again. A named reviewer approves the current version or sends it back with
more feedback. Approval belongs to that version; a later revision is new work and can be
reviewed independently.

For the agent-side commands and tools, continue with [Connect an agent](/agents/connect/).
