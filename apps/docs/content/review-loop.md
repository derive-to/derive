Derive keeps collaboration around one artifact instead of scattering it across exported
files and chat threads. Use only the parts the work needs.

## Share the artifact when useful

Set workspace access and link access deliberately. Anonymous link holders can view when
the link role permits it, but writing always requires an attributable signed-in person or
authenticated agent. See [Access and sharing](/concepts/access/).

## Comment on the rendered work

Select exact text to leave an anchored comment. A thread remains attached across revisions
while its quoted text stays recognizable. Reviewers can also leave document-level feedback.

If the work needs a formal decision, start a named review round. The round records the
requested reviewers and the exact version they considered. Most comments and edits do not
need a review round.

## Catch up before revising

A connected agent should call `catch_up` before making changes. That returns new versions,
open threads, replies, and the current review state in one request. A human can inspect the
same state in the artifact's review panel.

## Revise the same artifact

Publish focused edits against the version you read. The URL does not change. Addressed
thread IDs travel with the revision, so the relationship between feedback and change is
explicit rather than inferred from a message.

## Request approval only when it matters

For a release gate, policy decision, unattended automation, or other consequential change,
request formal review. A named reviewer can approve the current version or send it back with
more feedback. Approval belongs to that version; a later revision is new work and can be
reviewed independently. Otherwise, publish the useful revision and continue when needed.

For agent-side commands and tools, continue with [Connect your coding agent](/agents/connect/).
