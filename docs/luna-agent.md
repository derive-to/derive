# Luna inside Derive

Luna is the built-in agent. Its stable agent id remains `derive`.
The native chat lives at `/chat`. Artifact Ask uses the same runtime.
Both entry points use Luna directly. The previous agent picker is removed.
Their history includes only private Luna chats. Custom agents remain in Agents.
The Derive shell, artifact URLs, access checks, reviews, and versions remain in use.

## Scope

A chat belongs to one workspace and one human. Only that human sees it.
Workspace chat can find, read, create, and revise accessible artifacts.
Artifact chat treats “this” as its subject. It edits only that artifact.
A text selection narrows edits to the selected text. Other text stays as context.
History does not grant access. Each continuation checks membership and artifact access again.
Chat text stays private unless the human asks Luna to publish it.

## Runtime

The AI SDK orchestrates bounded model steps.
The runtime and provider transport use SDK messages directly.
The old message format, conversion helpers, and unused completion flag are removed. The provider adapters retain their transport and pricing rules.
Derive validates registered tool schemas before execution. Optional empty values become absent only when the schema allows absence.
Tools run serially. The run shares one output budget. The final model step has no tools.
Output contracts and landing ports still serve comments and background runs.
The chat budget is 120 seconds unless the host sets a lower budget.
A timeout aborts the model and blocks new tools. A save in progress finishes before the job settles.

The chat tools reuse Derive MCP handlers and act at the human’s seat.
They remain inside the chat workspace. Native chat has no connected-source call tool.
Slack retains its existing connected-source tools and identity restrictions.
Durable questions apply to native chat. Slack uses normal thread replies for clarification.
Slack reserves the thread before it records an inbound message. Concurrent follow-ups receive a busy reply.
Slack stores its receipt message. A lost redelivery updates that message and does not replay model work.
The receipt includes recovery guidance. It does not promise that an interrupted process still runs.
Comments retain their suggestion behavior. They do not silently publish edits.
Artifact content cannot authorize tools or change the chat scope.

## Questions

`ask_user` creates one durable question with an id and optional choices.
A proposed batch containing a question runs only the question, even when a write appears first.
The job enters `needs_you`. No later tool in that step can run.
The UI reads the saved question after reload.
An answer carries that exact question id. It must match the pending question.
A scoped artifact must still have the version the question names.
The server reserves one continuation with a compare-and-set, then saves the answer.
The model runs only after that saved answer. A second submission cannot reserve a second continuation.
If saving the answer fails, the server restores the pending question.
If the process stops after reservation, the lease eventually marks the job lost. Retry rechecks access and existing effects.
If a save was interrupted, retry stops. Check Activity and artifact versions before starting a new chat.

## Writes and stop

The publish tool confirms each saved version. The job records those versions as effects.
Each confirmed save records its effect before the save lock clears.
Retries receive the completed effects and must not replay them.
Artifact Ask rejects writes to another artifact. Selection chat accepts only focused edits inside its selection.
Every existing edit requires the version Luna read.
A newer artifact version stops an edit. Derive’s publish operation also enforces its normal base-version check.
Existing artifact edits still open a Derive review. The agent adds no separate preview approval step.

A persisted save marker fences cancellation. Stop waits until an active save finishes.
Cancellation uses the exact job metadata and revision, so a stale stop cannot race a save.
After stopping, the UI still shows completed effects. Stop does not undo a published version.
Use the artifact’s version history to restore it.
A lost run with an active save marker cannot retry. Its commit result is unknown.
This prevents an automatic retry from repeating a save after a process crash.

## Models

Set `OPENAI_API_KEY` to run chat directly through OpenAI Responses.
This mode offers only Luna and uses medium reasoning.
It ignores legacy DeepSeek gateway settings and library model entries.
Old explicit unavailable choices fail instead of silently changing models.

Explicit model ids win. A native chat stores an explicit choice for all its later turns.
An inherited choice reads the live instance default on each turn.
An OpenRouter gateway inherits `openai/gpt-6-luna` when `DERIVE_MODEL_NAME` is absent.
OpenRouter always includes Luna in the picker, even when the configured default is another model.
Hosted Luna uses medium reasoning and routes only to OpenAI.
Other models keep the configured provider policy and disabled reasoning.
Other compatible gateways still require their own model id.
The Codex runner inherits `gpt-6-luna`. Explicit runner, job, and agent models take precedence.
Claude accounts keep their Claude provider and model settings.
An unavailable explicit model fails. It never selects a different model silently.

## Local walkthrough

Use a dedicated worktree with Node 24 and its own data directory.
Run the Node API and Vite web app. Use Aside for browser work.
Disable the preview worker. Use a separate artifact sandbox origin.
Use synthetic local users and fixture artifacts. Do not use a shared database.
Use a stable API process during model turns. A development watcher can interrupt an in-flight turn.
Save screenshots and job evidence. Report which flows use real Luna and which use deterministic failure injection.
Stop both servers when the walkthrough is complete.
