# Builder prompt — Derive page-load performance PR

Copy everything below the line into the building agent's first message.

---

You are implementing the Derive page-load performance plan in one rolling PR. Your single
source of truth is the build handoff:

**https://derive.to/artifacts/derive-page-loads-build-handoff-q54du22n**

Read it fully before writing any code, then read the four documents it names at the top (the
page-loads plan `ia4t3ne5`, the register `akvf8ga9`, the manifest `xnjtpmvm`, and the query
doc's "what you already know" section). The handoff contains the commit sequence C1-C10, the
per-commit verification protocol, the CI gates that will bite, the measurement instrument, and
the out-of-scope list. Follow it in order. Do not re-propose anything its "do not re-propose"
sources close off.

Environment, already prepared for you:
- Worktree: `~/Projects/derive-page-loads`, branch `feat/page-loads`, tracking origin/main
  (repo derive-to/derive). Dependencies installed. Work here, never on main.
- Start with the handoff's **Step 0** (re-baseline production; #590 merged after the current
  register numbers were taken), then C1.
- Open ONE draft PR after C1 and keep pushing to it. Every push auto-deploys a preview at
  `https://derive-pr-<N>.derive-to.workers.dev` (the github-actions bot comments the URL on the
  PR — example of the convention: https://derive-pr-592.derive-to.workers.dev). The preview
  SHARES PRODUCTION'S DATABASE.
- Test identity + browser measurement gotchas are in the manifest (`xnjtpmvm` on derive.to,
  readable via the derive MCP or the register's link). Sign in only as the e2e test account.
  Anything that creates state happens in QA Lab and is deleted after; never open a chat
  session outside QA Lab; never give a probe artifact a world link.

Hard rules:
- NEVER merge or close the PR. Anir merges. Keep it green (`pnpm precommit`, `pnpm typecheck`,
  `pnpm test`, `pnpm test:pg` when SQL changes).
- One lever per commit, conventional commit titles, no em dashes in commits or PR text.
- Every commit gets a before/after journey measurement on the preview (floored, n>=3) recorded
  in the register `akvf8ga9` in place with provenance `prev pr-<N>`, and a measurement log in
  the PR description. A regression is reverted and recorded, not argued with.
- Update the register/page-loads docs through the derive MCP (`publish` with edits); never fork
  a perf doc.

Definition of done is in the handoff. When C1-C10 are done (or blocked), stop and report:
what shipped, every measurement with floors, what's blocked and why.
