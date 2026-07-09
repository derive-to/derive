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

   New artifacts land **unlisted** by default: hidden from the team library and
   search, but one link away for any workspace member (view or comment, per the
   workspace's setting). That is the draft state — never widen visibility yourself;
   when the work is approved, the human shares it with the team from the share
   dialog (that one act lists it for everyone).

3. **Ask, anchored.** For every open decision, leave ONE comment anchored to the
   exact sentence it's about — question + options + your recommendation:
   ```
   derive reply <thread_id> "…"          # in an existing thread
   # a NEW anchored question is a comment with a quote (use the API/MCP `quote`)
   ```

4. **It opens itself — then wait.** A publish reaches the user's open Derive tabs
   live: a NEW artifact auto-opens in their browser, a revision live-reloads the
   page they're reading. The publish result says whether that happened —
   `opened_in_tab: true` means they're already looking at it. Only when it's
   `false` (no tab open) open it for them:
   ```
   derive open <short_id>                 # the fallback, not the default
   ```
   Then wait. Over MCP, chain long-polls — each call blocks up to 50s and returns
   the moment the human acts (Send back, Approve, or a new comment), so feedback
   reaches you in seconds, not on a polling cadence:
   ```
   catch_up(short_id, wait: 50)           # returns early on any human action
   ```
   Loop the call while `review.state` is `pending`. Over the CLI (no long-poll),
   fall back to `derive status` every ~60–90s. Stop cleanly after ~30 minutes of
   silence: report the artifact URL and how to resume, and end the turn.

5. **On `sent_back` — SWEEP and ACK (non-negotiable).** Read **every** thread on the
   artifact, not just the ones you opened — the user can comment anywhere, on
   anything:
   ```
   derive comments
   ```
   For **each** human comment: address it (fold the answer into the revision, or
   reply in-thread) AND leave an ack — a 👍 reaction at minimum, so nothing you were
   told reads as silently dropped. Over MCP the ack is one call:
   `comment(short_id, reply_to: <thread>, react: "👍")` — it lands on the thread's
   latest human comment. Ack FIRST, then revise: the human should see uptake
   before the new version replaces the page. Finalizing with an unaddressed human
   thread is a bug.

6. **Revise + re-request.**
   ```
   derive publish plan.md --review --message "what changed"
   ```
   A re-request replaces only this person's pending round (no dupes). Anchored
   threads whose quoted text you changed re-anchor automatically or flip to
   "outdated" — they never attach to the wrong place.

7. **Repeat 4–6 until the user says go.** The loop is a live dialogue — there is no
   Approve button in the app. The go-signal arrives one of three ways, all equal:
   a Send back whose feedback reads as "good, ship it" with no change requests
   (read the replies — that IS the approval); the user saying it in the terminal;
   or a formal `derive approve` / `approved` round state (CLI and headless flows).
   When feedback contains both a go and change asks, the asks win — revise first.
   The user is NEVER required to resolve threads — Send back is the one gesture;
   you settle thread state.

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
- MCP equivalents (claude.ai / Claude Code connector): `publish(request_review:true)`
  (its result carries `opened_in_tab` + the url), and `catch_up` reports a `review`
  field — pass `wait: 50` to long-poll it instead of sleeping between polls.
