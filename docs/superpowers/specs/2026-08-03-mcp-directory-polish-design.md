# MCP Directory Polish: Design

Date: 2026-08-03. GTM step 10 (S4/P7). Purpose: make Derive submittable to every MCP directory in the blitz list. The two documented Claude-directory rejection causes are missing tool annotations and no privacy policy; this removes both and adds the install CTAs. Branch `feat/mcp-directory-polish` off main.

Decisions locked with Connor: Claude drafts the privacy copy and Connor reviews it before it ships; install CTAs are Cursor + Claude Code, both pointing at the hosted remote MCP.

## 1. Tool annotations, both servers

Every tool gets MCP `annotations`: a human-readable `title` plus honest behavior hints. The hints are read by directory reviewers AND by clients' auto-approval UX, so a wrong `readOnlyHint: true` is worse than a missing one. The implementer judges each tool FROM ITS CODE (the table below is the starting claim, to verify per file); the reviewer's job is to check the honesty of every hint.

Remote server (`apps/api/src/mcp.ts` + `apps/api/src/mcp-tools/*.ts`, one `register<Name>Tool` each; 4 of 14 already carry `readOnlyHint: true`):

| Tool | title (proposed) | readOnly | destructive | notes to verify |
|---|---|---|---|---|
| read | Read an artifact | true | - | already annotated? add title |
| find | Find artifacts | true | - | annotated; add title |
| catch_up | Catch up on changes | true | - | annotated; add title |
| list_workspaces | List workspaces | true | - | annotated; add title |
| publish | Publish an artifact | false | false | additive versioning; nothing is overwritten irreversibly |
| comment | Comment and review | false | false | additive; resolving threads is reversible |
| organize | Tag and collect | false | false* | tags REPLACE the set; verify whether that warrants destructive: true |
| stage | Stage an upload | false | false | mints short-lived upload/API credentials |
| checkpoint | Save a checkpoint | false | false | additive lineage |
| automate | Manage automations | false | ? | if it can delete/disable automations, destructive: true |
| use | Work a workspace context | false | false | dispatches instructions/work |
| use_runner (if exposed) | Run hosted work | false | ? | verify registration + behavior |
| call | (verify name) | ? | ? | read the file |
| code | (verify name) | ? | ? | executes code? verify sandbox + honest hints |

npm package (`packages/mcp/src/index.ts`, 8 `registerTool` calls, 5 already have readOnlyHint): same treatment — titles on all, hints verified per tool (list/read/catch_up read-only; publish/comment writers, non-destructive).

`idempotentHint`/`openWorldHint`: set only where clearly true from the code (e.g. tools that only touch Derive's own API are closed-world); do not guess.

## 2. Privacy policy page

`apps/web/public/site/privacy.html`, third self-contained page in the marketing-site family, same design system as `pricing.html` (read it first; reuse its header/footer/typography verbatim so the site stays one visual family). Served exactly like pricing:
- `routes/marketing.ts`: GET `/privacy` (both node paths, mirroring the pricing handler pair).
- `worker.ts`: `privacy: siteFetch(env, baseUrl, "/site/privacy")` beside `pricing`.
- `wrangler.toml` `run_worker_first`: add `"/privacy"`.
- `lib/serve-web.ts` API_EXACT: add `"/privacy"` if the pricing/site pattern requires it (mirror whatever pricing does).
- Footer links: the site pages' footers (index, pricing, and the new page itself) link to Privacy.

Content (Claude drafts, Connor reviews before ship): plain-language and honest, sections roughly — what we collect (account: email/name/handle; content: artifacts, versions, comments; usage: view analytics and signup attribution), what we never collect (no ad trackers, no third-party analytics scripts, no selling data), subprocessors as an honest named list (Cloudflare hosting/CDN, Neon Postgres, Stripe billing, Resend email, Slack + GitHub only when a workspace connects them, model providers only for opt-in AI features), retention and deletion (account deletion purges content; published-URL permanence explained), self-host ("run it yourself and none of this applies"), contact (hello@derive.to), effective date, and a "plain-language version, not legal advice" note. No em dashes. No customer names, no unpublished figures (public repo + public page).

REVIEW GATE: the drafted page goes to Connor rendered (screenshot or served preview) and ships only on his approval. The PR can carry it, but merge waits for that sign-off.

## 3. Install CTAs (README + docs)

- Cursor deep-link badge: `cursor://anysphere.cursor-deeplink/mcp/install?name=derive&config=<base64 of {"url":"https://derive.to/mcp"}>` behind Cursor's official "Add to Cursor" badge image, in the README's MCP/connect section. Verify the current deep-link format against Cursor's docs at build time.
- Claude Code one-liner beside it: `claude mcp add --transport http derive https://derive.to/mcp`.
- Same pair wherever the repo's docs present connecting an agent (grep for the existing "connect" doc surface; add, don't restructure).
- Both target the hosted remote MCP (OAuth 2.1 + PKCE, Streamable HTTP — already live).

## 4. Out of scope

Directory submissions themselves (GTM "Submissions staged" steps), the ChatGPT App Directory packaging (its own GTM bet), any change to tool behavior or descriptions beyond annotations, in-app connect-agent UI changes.

## 5. Done when

Every tool on both servers carries `title` + accurate hints (verified in an MCP inspector or test listing); `derive.to/privacy` serves the reviewed page on both runtimes with footer links; README shows both install paths; all repo gates green.

## Global constraints

Public repo: no customer names/figures anywhere including commits. No em dashes in user-facing copy. corepack pnpm everywhere; full ci/typecheck/coverage gates; known mcp.test.ts coverage flake documented (passes in isolation). Tool descriptions must NOT change in this work — annotations only — so existing agent behavior and tests stay untouched.
