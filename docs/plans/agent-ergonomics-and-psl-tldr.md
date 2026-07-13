# TLDR: Derive's agent ergonomics, and the Public Suffix List

Two short explainers, written after the `feat/agent-read-tools` arc (PR #415, PR #416) landed on main — one on where the product stands, one on a specific piece of internet infrastructure ("the Mozilla thing") that the next tier of work depends on.

## The app, in one line

Derive is an open-protocol platform for hosting HTML/MD artifacts that any AI agent — Claude Code, Cursor, ChatGPT via MCP — can find, read, edit, and visually verify, not just view. The same tool vocabulary works identically over the remote MCP server (OAuth), the self-hosted stdio CLI, and plain REST.

What that ladder actually looks like today:

- **Find** — grep within one artifact, or across a whole workspace (`search`, `short_id` optional), ripgrep-style, self-locating (`§ Section` labels), capped with honest truncation notes.
- **Read** — outline → heading/landmark section → `@N` region reads for headless designed pages → `lines:"40-120"` windows → exact source / markdown / text.
- **Edit** — a real coding-agent contract on hosted documents: exact-match edits, `occurrence` to disambiguate a repeated string, two-tier miss diagnostics that explain *why* a match failed, and optimistic concurrency that shows a diff of what changed instead of a blind "retry."
- **Verify** — `read(render:"top"|"full"|"marked")`: publish, then actually see the rendered page, including a Set-of-Mark overlay that shares coordinates with the text-based region map.
- **Collaborate** — versioned history, anchored comment threads, a propose → approve review loop, and `catch_up(wait)` so an agent can long-poll a human's next move instead of sleeping in a loop.

Why it matters competitively: Claude Artifacts and ChatGPT Sites are rich, but single-vendor *output* surfaces — only their own chat agent can touch one. Derive is a multi-agent *working* surface: the artifact is a live, editable, reviewable thing any connected agent can act on. That's the whole differentiation, and it's been adversarially tested (five independent review passes, real complex content, real production surfaces) rather than just built and hoped for.

## "The Mozilla thing": the Public Suffix List (PSL)

The PSL is a plain-text list Mozilla maintains (`publicsuffix.org`, mirrored on GitHub) that every major browser reads. It answers one question: *which domain suffixes are "public,"* meaning a random stranger can register their own name under it — so `alice.github.io` and `bob.github.io` must be treated as **completely separate sites** (separate cookies, separate local storage), not as two pages of one `github.io` site. Without the PSL entry, a browser would otherwise let `alice.github.io`'s script read `bob.github.io`'s storage, because by default anything under one registrable domain shares an origin family.

**Why Derive needs it.** Today, an artifact renders inside a locked-down sandbox (no storage, no working History API, no service workers) because it's served from a *shared* origin — safe, but it means an artifact can never behave like a real app. The fix used by GitHub Pages, CodeSandbox, and `claudeusercontent.com` alike is to give every artifact its **own subdomain** on a dedicated usercontent domain, so the browser isolates each one automatically. That isolation guarantee is *only real* if the domain is registered on the PSL — otherwise every artifact subdomain would still nominally share one origin family with every other artifact and with Derive itself.

**Why it's called out as a "start now" item.** Getting a domain added to the PSL means filing a pull request against Mozilla's list, and it only takes effect once it ships in a new stable release of Chrome, Firefox, and Safari — a matter of months, not days, and nothing accelerates it. Everything else in the origin-isolation plan (per-artifact subdomain assignment, host-aware CSP, a back-button-safe navigation shim) can be built in parallel — but the PSL submission is pure lead time sitting on the critical path, so the moment the underlying product decision ("should artifacts get app-like capability?") is a yes, submitting to the PSL should happen immediately, in parallel with the engineering, not after it.
