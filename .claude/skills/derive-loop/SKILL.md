---
name: derive-loop
description: Draft a plan or artifact, publish it to Derive with inline questions, and run the review loop — the human reviews in the app and Sends back, you revise until they Approve. Use when the user says "/derive", "run the derive loop", "draft this on Derive and get my review", or wants an agent↔human review round on a document.
---

# The /derive loop

You draft; the human reviews in the Derive app; you revise until they approve. The
loop lives on the artifact, not in the terminal — your questions are anchored
comments on the exact sentence in doubt, and the human answers inline.

The `derive` CLI (`packages/cli/bin/derive.js`, installed as `derive`) owns the
plumbing: connect, publish, status, the human verbs. You own the judgment: what to
draft, what to ask, and how to revise. Everything below is CLI calls.

## Connect ONCE — then never click again (the default)

Before anything, ensure a saved session — this is the loop's default and the whole
point: the user approves **one** browser consent, ever, and every publish/comment
after that is zero-click.

```
derive status >/dev/null 2>&1 || derive login   # only prompts if not already connected
```

`derive login` runs OAuth (one Approve), then saves the access **and refresh** token
(0600, `~/.config/derive/credentials.json`). Every later `derive` command refreshes
that token silently — no flags, no clicks. Never ask the user to click per action; if
a call 401s, run `derive login` once and retry. The grant carries the user's
identity, so comments are attributed to you-acting-for-them.

Workspace: a `~/.derive/config.json` profile (with a purpose note) and a repo
`.derive` pin select which one; `--profile <name>` overrides. Local server:
`--server http://localhost:8099 --token <TOKEN>`.

## The loop

1. **Scope.** Ask the user 2–3 sharp questions in the terminal, then draft the plan
   (Markdown for plans, HTML for pages/decks).

2. **Publish + request review.**
   ```
   derive publish plan.md --title "…" --review
   ```
   `--review` opens a review round asking the user to review this version. The id is
   saved to `derive.json`, so later commands need no `--id`.

3. **Ask, anchored.** For every open decision, leave ONE comment anchored to the
   exact sentence it's about — question + options + your recommendation:
   ```
   derive reply <thread_id> "…"          # in an existing thread
   # a NEW anchored question is a comment with a quote (use the API/MCP `quote`)
   ```

4. **Open it and wait.**
   ```
   derive open                            # opens the artifact for the user
   ```
   Then poll:
   ```
   derive status                          # review: pending | sent_back | approved
   ```
   Poll every ~60–90s while `pending`. In a harness with scheduled wakeups, sleep
   between polls rather than busy-looping.

5. **On `sent_back` — SWEEP and ACK (non-negotiable).** Read **every** thread on the
   artifact, not just the ones you opened — the user can comment anywhere, on
   anything:
   ```
   derive comments
   ```
   For **each** human comment: address it (fold the answer into the revision, or
   reply in-thread) AND leave an ack — a 👍 reaction at minimum, so nothing you were
   told reads as silently dropped. Finalizing with an unaddressed human thread is a
   bug.

6. **Revise + re-request.**
   ```
   derive publish plan.md --review --message "what changed"
   ```
   A re-request replaces only this person's pending round (no dupes). Anchored
   threads whose quoted text you changed re-anchor automatically or flip to
   "outdated" — they never attach to the wrong place.

7. **Repeat 4–6 until `approved`.** Approval is the go-signal. The user can approve
   from the app's review card OR say "go" in the terminal (`derive approve`); both
   settle the round. The user is NEVER required to resolve threads — Send back is the
   one gesture; you settle thread state.

## Modes

- **auto** (default): on each `sent_back`, revise and re-request without pausing.
- **`--confirm`**: after reading the feedback, report it in the terminal and wait for
  the user's go before revising.
- **`--yolo`**: skip review rounds — publish and open the finished artifact only.

## Build stage

Once a plan is `approved`, build the real deliverable (HTML/deck/doc) as its own
artifact and run this exact loop on it, anchoring questions on the rendered element
or sentence in doubt. Keep the plan linked in the built artifact's header — the
resolved threads across both are the decision log.

## Reference

- `derive status --json` → `{ review, rounds, open_threads }` for scripting.
- `derive send-back` / `derive approve` are the human verbs (the app's Send
  back / Approve buttons hit the same routes).
- MCP equivalents (claude.ai / Claude Code connector): `publish(request_review:true)`,
  and `catch_up` reports a `review` field — the same poll target as `derive status`.
