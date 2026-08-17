# Working in this repo

## This repository is PUBLIC

Everything you write here is world-readable and, once pushed, effectively
permanent. That includes commit messages, branch names, PR titles and
descriptions, PR and issue comments, code comments, test fixtures, and any file
you add.

**Never write into any of those:**

- **Names of customers, prospects, or their employers.** Not in a commit
  message, not as motivation for a change, not in a code comment. "A $COMPANY
  employee reported X" identifies both a company and, in a small enough
  population, a person. It also discloses that they are a user.
- Names, emails, handles, or job titles of individuals outside the project.
- Internal URLs, ticket IDs, or intranet links, whether ours or a customer's.
- Support-ticket contents, private feedback, sales conversations, or anything
  from a private Slack channel.
- Revenue, customer counts, pipeline, or other unpublished business figures.
- Anything about unannounced partnerships or launch dates.

**Write the motivation generically instead.** The reason a change is worth
making almost never depends on who asked:

| Don't | Do |
|---|---|
| "An employee at &lt;named company&gt; hit our block page" | "We've had a report of derive.to being blocked by a corporate web gateway" |
| "&lt;Named company&gt;'s security team flagged this" | "Reported via a customer security review" |
| "Blocking the &lt;named company&gt; deal" | "Blocks enterprise onboarding" |

If the specific identity genuinely matters to a reviewer, it belongs somewhere
private, such as a Derive document or internal issue. The public artifact links to
nothing or says "see internal notes".

**Before pushing or opening a PR**, re-read the commit message and PR body for
the above. It is much cheaper to catch it there than after.

**If something does get published:** amending a commit message and force-pushing
an unmerged branch, plus editing the PR body, removes it from every normal view
but the old commit object stays reachable by SHA on GitHub, and the PR
timeline records that a force-push happened. Fix it immediately anyway, and flag
it to a human, who can ask GitHub Support to garbage-collect the orphan if the
disclosure is serious.

## Git

The main checkout at `~/derive/derive` is shared across concurrent sessions.

- `git fetch origin main` **before branching**. Local `main` is routinely many
  commits stale, and branching off it inherits already-fixed lint failures that
  then look like yours when the pre-push hook rejects the push.
- Verify the branch in the *same command* as the commit or push
  (`test "$(git rev-parse --abbrev-ref HEAD)" = ... || exit 1`).
- **Never read a push's success from a pipeline's exit code.** `git push | tail`
  reports `tail`'s status, so a rejected push looks like success. Confirm with
  `git ls-remote --heads origin <branch>` and compare SHAs.

Hooks (`.githooks`, enabled by `pnpm install`): pre-commit runs `pnpm run ci`,
pre-push runs the full `pnpm verify` (ci → typecheck → **test:coverage**). The
coverage ratchet only runs in `verify`, so `pnpm test` passing is not the same
as the push gate passing. Run `pnpm verify` before claiming a change is green.
Both hooks take minutes; run pushes in the background rather than timing out and
restarting the chain from scratch.
