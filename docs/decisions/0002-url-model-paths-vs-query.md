# ADR 0002 — URL model: named feeds are paths, filters are query params

**Status:** accepted (2026-07-03)

## Context

The web SPA (TanStack Router, `apps/web/src/routes/*`) grew a set of ad-hoc URL
conventions on the home route `/`. The library carried six search params, and the
mutually-exclusive "which feed am I looking at" choice was spread across two keys
with mismatched names:

- `/?f=favorites` — the favorites feed (`f`, an abbreviation)
- `/?scope=following` — the following feed (`scope`, a full word)
- `/?tag=`, `/?collection=`, `/?q=`, `/?author=` — filters + search

Three problems followed:

1. **Two keys, one concept.** `f` and `scope` select the same kind of thing (a
   feed), yet one is a cryptic letter and one a word. Each key had exactly one legal
   value (`f` was only ever `favorites`; `scope` only ever `following`) — the tell
   that these are *values of one dimension*, not dimensions of their own.
2. **Non-canonical URLs.** Nothing forbade `/?f=favorites&scope=following&tag=x`.
   A priority `if/else` silently picked a winner, so two different URLs could render
   the identical screen.
3. **Peer nav, split mechanisms.** In the rail's top tier, *All · Favorites ·
   Following · People* sit as siblings, but the first three were `/?…` query states
   while People was a real `/people` route — four peers, two URL models.

## Decision

**Path = the place you're viewing (a noun). Query = how that place is filtered or
searched (adjectives).**

- **Fixed, singular, self-contained feeds are routes:** `/` (all artifacts),
  `/favorites`, `/following`. Each has its own heading, empty state, and semantics —
  they are destinations, not filters. (`/people` was one of these until the people
  directory moved into Settings; the path survives as a redirect.)
- **Parameterized filters that compose over the shared library grid stay query
  params on `/`:** `?tag=`, `?collection=`, `?author=`, `?q=`. They refine the same
  view and combine with search, which is exactly what query params are for.
- The base feed is chosen by the **route**; the `Library` body takes a `view` prop
  (`"all" | "favorites" | "following"`) and reads the filters from search
  (`useSearch({ strict: false })`, since one body renders under three routes).

The rail's top tier is structurally uniform — every entry is a route link. (It listed
six when this was written; Brandprint and People have since moved into Settings, which
the rule below already covered: both are places, so both are path segments.) The
library's search schema drops `f` and `scope`; `/favorites` and `/following` accept
only `?q=`.

**Settings sections follow the same rule.** A settings section (Profile, Members,
GitHub, …) is a place, not a filter — so it is a path segment, `/settings/$section`,
not `/settings?tab=`. This also harmonizes the client with the server's own settings
paths (`/settings/github/app/new`, `/settings/github/app/created`). `/settings`
redirects to the first section; the one-shot GitHub-install signals (`gh_install`,
`gh_error`) stay query params, because a handshake token is a modifier, not a place.

## No abbreviations in human-facing URLs

The product is **pre-production** — nothing has shipped, so no links exist in the
world to break. That removes the one constraint that would otherwise protect terse
public share URLs, so every human-facing abbreviation was expanded to a full word,
consistent with the API's own resource names (`/v1/artifacts`, `/v1/users`):

| Was | Now | Surfaces updated in lockstep |
|---|---|---|
| `/a/:ref` | `/artifacts/:ref` | routes; every in-app link; the server unfurl / embed / oembed / canonical-redirect handlers; the email / Slack / GitHub / webhook / MCP link-builders (`artifactUrl` in `core`); cross-doc in-artifact links (`core/cross-doc.ts`); the 3-place edge contract (`serve-web.ts` + `wrangler.toml` + Vite proxy) |
| `/u/:handle` | `/users/:handle` | routes; links; the profile unfurl + the OG-image endpoint (`/v1/og/users/:handle`) |
| `?c=<thread>` | `?comment=<thread>` | the artifact route; notification-bell; the copy-comment-link action; the email / Slack / GitHub builders |
| `?q=` | `?query=` | the library + people search routes; `api.ts`; the `/v1/artifacts`, `/v1/users`, `/v1/people`, `/v1/users/search` handlers; the MCP client |

Note the oembed handler parses the ref out of the URL with a **regex**
(`/^\/artifacts\/([^/]+)$/`) — a string-rename misses that, so the API test suite is
the guard (it asserts the exact public URLs). Internal `q` field names in `core`/`db`
stay `q`; only the URL-facing param changed.

## Kept terse (machine plumbing + genuine standards)

Not everything is a human-facing URL. These stay short — pragmatic, not dogmatic:

- **`/raw/:shortId/v/:n/*`** and **`/raw/:shortId/p/:proposalId/*`** — the sandboxed
  byte-serving paths. Auto-generated, embedded *inside* published artifact HTML for
  relative asset resolution, never hand-typed. Renaming risks breaking asset loading
  for zero human-facing gain.
- **`/v1/og/*`** — the OpenGraph image endpoints. `og` is the protocol's proper name;
  crawler-facing and invisible to users.
- **`/v1`, `oauth`, `mcp`, `api`, `.well-known`, `id`, `ref`** (a code-level param
  name, not a URL segment), **`healthz`/`readyz`** — universal standards.
- The **API** still takes `scope: "following"` on the wire (`api.listArtifacts`) —
  a server-query param, a different layer from the client URL.

## Rejected alternatives

- **Just unify the query keys** (`/?view=favorites`, `/?view=following`): the
  smallest diff, and it kills the `f`/`scope` naming bug — but it leaves the deeper
  inconsistency (Favorites/Following as query while People is a path) in place.
- **Full resourceful paths** (`/tags/$tag`, `/collections/$id` too): the most
  internally consistent, but tags/collections *compose* with `?author=`/`?q=` as
  filters of the same grid, and their `?collection=` links are already shared —
  promoting them changes shareable URLs and threads nested routes through the
  collection toolbar + PR-nesting rail for marginal benefit. Kept as query params.

## Consequences

- New client paths need **no server change** — the SPA catch-all already serves the
  shell for any non-API GET (`mountWeb`, `serve-web.ts`), so deep-links and refresh
  on `/favorites` / `/following` just work.
- Shared/bookmarked `/?f=favorites` or `/?scope=following` links stop selecting the
  feed after this change (they resolve to the unfiltered home). Acceptable: these
  are session-gated personal feeds, not public shareables.
- The rule is the guard against regression: a new "feed" is a route; a new way to
  *slice* the library is a query param.
