# 0001 — One review loop, one write behavior

Decided August 2026, by the whole team, on an internal Derive doc ("Removing Proposals and
Approval") whose pinned threads are the decision log.

## The model

- **Publishing is live.** An agent's write lands exactly like a person's: a new version of the
  artifact, kept and restorable, with the publish fan-out (bell, email, Slack, the open tab).
- **Publishing sends the note.** A write that asks for review opens a review round; the round,
  the email and the Slack DM all carry the requester's note.
- **Answers are comments plus Send back.** A review round has two states, `pending` and
  `sent_back`. The Send back note is the reply channel — a note that reads "good to go" IS the
  go-signal. There is no separate approve step.
- **One brake.** The workspace setting `agentWrites` (on by default). Off, agents stop writing
  everywhere an agent credential can write: hosted runs and asks are neither materialized,
  dispatched, nor claimed — no lease, no model spend — attended chat's publish refuses with the
  drafted change surfaced in the reply, and an agent-credentialed publish (MCP or HTTP) is
  refused at the API. Every reader of the switch fails closed on a settings error. Mentions in
  comment threads never write either way.

## What this replaced, and why

Two review ceremonies — the proposal system (ask-first drafts awaiting an editor) and the
approval machinery (an `approved` round state plus a served-version pointer) — and a
five-dimensional write-policy machine deciding how each agent write lands: a killswitch, a
workspace auto opt-in, a per-target publish/draft mode, a model-confidence floor, and a
"credentialed" rule barring any run that read outside data from publishing directly.

Nobody on the team used either ceremony. The policy machine survived a first refactor attempt
in name-changed form, and the audit of that attempt found every serious bug in the glue the
machine forced into existence (demoted drafts with no home, two executors' prompts drifting,
an unreachable third outcome the code itself annotated as unreachable). The safety the machine
promised was largely advisory — it ran inside the executor, which already held the token.

## The named losses

1. **The outside-data rule.** A run with a spendable connection could never live-publish, on
   the theory that pulled content can carry planted instructions. Deleted: the bar was
   advisory, it dead-ended large-document automations, and it contradicted the trust already
   extended to the brand profile. The tripwire: this rule returns, enforced **server-side at
   the publish route** (the run id is on the claim), the day untrusted-source publishing
   worries a real customer.
2. **Formal approval.** The record of "who approved" now lives in the Send back note and the
   round's `resolved_by`. Approval returns as a feature when a paying customer needs sign-off,
   built for them.
3. **Ask-first drafts.** A commenter-grade collaborator suggests changes in comments instead
   of handing over ready-to-apply text. Revisit if that breaks a real workflow.

## Consequences worth stating

- Chat-lane edits publish live (with a forced review round); previously they always drafted.
- A context ask on a document can publish through the context agent's own standing, even when
  the asker could not publish directly — the same trust as an automation firing on a webhook.
- Fresh workspaces start with agent writes ON. The old pair of flags (`agentKillswitch`,
  `agentAutoEnabled`, both off by default) are retired keys the settings parser drops.
- The CLI runner no longer hand-copies a write gate; the one remaining hand-copy is the run
  contract, whose parity test now imports core's string instead of comparing copy to copy.
