# MCP Directory Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Remove the two documented Claude-directory rejection causes (missing tool annotations, no privacy policy) and add the Cursor + Claude Code install CTAs.

**Architecture:** Annotations are per-tool metadata additions with zero behavior change; the privacy page clones the pricing page's serving pattern end to end; the CTAs are README/docs edits. Branch `feat/mcp-directory-polish` off main.

**Spec:** `docs/superpowers/specs/2026-08-03-mcp-directory-polish-design.md` — binding, including its per-tool table and the Connor review gate on privacy copy.

## Global Constraints

- Annotations ONLY: tool names, descriptions, schemas, and behavior must not change. `git diff` on each tool file should show only the `annotations` object (and `title` within it).
- Hints must be honest per the tool's actual code; when in doubt, omit the hint rather than guess. A reviewer verifies every hint against the file.
- No em dashes in user-facing copy (privacy page, README). Public repo: no customer names or unpublished figures.
- corepack pnpm; commit per task; the full `pnpm run ci` precommit runs minutes, let it run; `--no-verify` forbidden unless the only failure is the documented api `test/mcp.test.ts` coverage flake (verify in isolation first).
- Commit trailer (both lines):
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01VMUBaVBw7bCW7HqWPvwiKe`

### Task 1: Remote-server annotations (apps/api)

Files: `apps/api/src/mcp-tools/*.ts` (14 files; each has one `register<Name>Tool` with a config object where 4 already carry `annotations: { readOnlyHint: true }`). Test: `apps/api/test/mcp.test.ts` — add one test that calls `tools/list` and asserts EVERY returned tool has `annotations.title` (non-empty) and an explicit `readOnlyHint`, so a future tool can't ship unannotated.

Steps: read each tool file top to bottom; fill the spec table's verify cells; add `annotations: { title, readOnlyHint, ...judged hints }` per tool; write the tools/list test (RED first: it fails on the 10 unannotated tools); GREEN; run `corepack pnpm --filter @derive/api test mcp.test.ts billing-gate.test.ts`; commit `feat(mcp): every remote tool carries directory annotations`.

### Task 2: Package annotations (packages/mcp)

Files: `packages/mcp/src/index.ts` (8 registerTool calls, 5 with readOnlyHint). Test: the package's existing test file gains the same tools/list assertion (find it: `packages/mcp/test/` or colocated; mirror its harness).

Steps: same judgment process; titles everywhere; RED/GREEN; `corepack pnpm --filter @derive/mcp test` (verify the filter name from packages/mcp/package.json); commit `feat(mcp): stdio package tools carry directory annotations`.

### Task 3: Privacy page + serving

Files: create `apps/web/public/site/privacy.html`; modify `apps/api/src/routes/marketing.ts`, `apps/api/src/worker.ts` (siteFetch map + the `m.privacy()` handler mirroring pricing), `apps/api/wrangler.toml` (`run_worker_first` gains `"/privacy"`), `apps/api/src/lib/serve-web.ts` if pricing appears there (mirror exactly), and the three site pages' footers (index/pricing/privacy) gain the Privacy link. Test: mirror whatever tests cover `/pricing` serving (grep `pricing` in apps/api/test; extend the same file for `/privacy`).

Content: per the spec's section-2 outline, in pricing.html's exact design system (read it first; copy its header/nav/footer/CSS vars verbatim). Honest subprocessor list per the spec. Effective date 2026-08-03. "Plain language, not legal advice" note. No em dashes.

Commit `feat(site): the privacy policy page`.

### Task 4: Install CTAs + gates

Files: `README.md` (the section presenting MCP connection; add the Cursor badge deep-link + the `claude mcp add --transport http derive https://derive.to/mcp` one-liner) and the equivalent docs surface (grep for where the repo documents connecting an agent; add the same pair). Verify Cursor's current deep-link/badge format from cursor.com docs (WebFetch) before writing it.

Then whole-branch gates: `corepack pnpm run ci`, `typecheck`, `test:coverage` (flake rule applies). Commit `docs: one-click MCP install for Cursor and Claude Code`.

### Task 5: Final review + handoff

Whole-branch review (most capable model) with special attention to hint honesty (spot-check each claimed readOnlyHint against the tool's code) and privacy-copy accuracy against the repo's real data flows (does it name a subprocessor we don't use, or miss one we do — check config.ts/DEPLOY.md for the true list). Fix findings. Render the privacy page (local dev server or the built site file) and screenshot it for Connor's review gate. Push + PR handoff; PR body notes merge waits on Connor's privacy-copy approval.
