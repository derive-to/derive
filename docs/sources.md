# Sources: connecting an MCP server

A **source** is a Model Context Protocol server your agents can read from during a run. Connect
one by URL, bind it to an automation, and that automation's runs can call the server's tools.

Anything that speaks MCP over streamable HTTP works. There is no vendor list and no per-vendor
integration to write.

## Connecting one

Settings → Sources. Give it a name (it prefixes the server's tools, so an agent can see where each
tool came from) and the server URL. Then one of two things happens.

**The server asks you to sign in.** Most hosted servers do. Connect takes you to the provider's
consent screen, you approve, and you land back on Sources with the connection active. Nothing is
stored until the server has actually answered.

**The server takes a token.** Some servers have no sign-in. Paste one into the Token field. It is
encrypted at rest, spent server-side, and never returned by any API. You will only ever see its
last four characters.

Leave the Token field empty unless you know the server has no sign-in. Sign-in is better in every
way that matters: nothing long-lived is stored, the grant is revocable from the provider's side,
and we ask for the narrowest scopes it offers.

### What "connected" means

`connect` contacts the server immediately, lists its tools, and records a hash of that list in the
connection itself. A 201 means the server answered. It is not a row stored hopefully.

That hash is the **pin**, and it is the whole defense against tool poisoning. Tool names and
descriptions from an MCP server land verbatim in the model's prompt, so a hostile or compromised
server can rewrite them between runs to say whatever it likes. If the tool list changes, the pin
stops matching and the connection goes **quiet**: runs get no tools from it until a human
reconnects and sees the new list. Fail-closed, on purpose.

A connection with no pin is refused outright, which is why a connection waiting on sign-in cannot
be used by anything.

### When it does not connect

The four failures are told apart, because the fix for each is different and three of them used to
produce the same sentence:

| What you see | What happened |
| --- | --- |
| needs authorization | The server wants a credential. Sign in, or paste a token. |
| nothing MCP-shaped there | 404 or a non-JSON-RPC 200. Usually the wrong path. If the URL ends in `/mcp`, the root is suggested. |
| could not reach it | DNS, TLS, or timeout. Nothing answered. |
| refused the token | You pasted one and the server rejected it. |

## Signing in, in detail

Discovery, registration, PKCE, the code exchange, and refresh all come from
`@modelcontextprotocol/sdk`. What is ours is where the token lives and when it is stale.

- **Registration is dynamic** (RFC 7591). Derive registers itself with each server the first time
  someone connects it, as a public client with PKCE S256. No per-deployment vendor paperwork.
- **Scopes are narrowed.** Asking for everything a server advertises is the obvious implementation
  and the wrong one: Linear advertises `read write openid email`, so its consent screen offered
  Write for a feature that reads. Plainly elevated scopes are dropped. If nothing recognisably
  narrow is left, no scope is sent and the authorization server applies its own default.
- **State is signed, not stored.** The PKCE verifier rides inside an HMAC'd, 15-minute state token,
  so a flow that is never completed leaves nothing behind.
- **Only the person who started it can finish it.** State proves who began the flow and travels in
  a URL, so it cannot also prove who finished it. A live session has to, and must match.
- **Tokens refresh themselves** shortly before expiry, with a compare-and-swap write so two runs
  refreshing at once cannot leave the older token installed.

The connection is pinned *after* consent returns, because until then there is no credential to list
tools with. That re-pin is the one part of this flow no library does for us.

## Using one

Bind the source to an automation: Settings → Automations, the Sources field. Only active sources
are offered. A run sees the tools of the sources bound to *that automation* and nothing else, and
the credential is resolved server-side at call time, so the model never holds it.

Sources can be bound when you create an automation and changed afterwards.

### A run that reads from a source files a proposal

This is the part worth knowing before you design around it.

The autonomy gate refuses to live-publish for any run that had a spendable connection. Such a run
files a proposal for a human to accept, and that rung sits above any per-target publish mode, so
no setting buys past it. A run that reads outside data acts on somebody's say-so.

So a document backed by a source updates through a proposal each time, not on its own. If you want
a dashboard that refreshes unattended, that is a product decision that does not exist yet, not a
setting you are failing to find.

See `packages/core/src/autonomy.ts`, which is also honest about the limits of what the rung
guarantees.

## Verifying it

Most tests here drive a server written in this repo, which agrees with our assumptions by
construction. Real servers do not. Two opt-in suites point at live ones:

```bash
LIVE_MCP=1 npx vitest run test/live-servers.test.ts        # packages/broker
LIVE_MCP=1 npx vitest run test/live-oauth.test.ts          # apps/api
LIVE_MCP=1 npx vitest run test/live-hosted-source.test.ts  # apps/api, the whole scenario
```

They are off by default because CI must not depend on somebody else's uptime, and because they
make real requests to third parties, including a real dynamic client registration.

They exist because every defect below was found by pointing the code at a real server and none of
them would have surfaced against a stub:

- A server may keep the SSE stream open after replying. Reading to EOF stalled every call to such
  a server for 20 seconds and then blamed the server.
- Tool names longer than 64 characters, or containing a dot, are rejected by model providers.
- An authorization server can live on a different origin from the MCP server it guards
  (`access.stripe.com` guards `mcp.stripe.com`), and its metadata may only be at the path-aware
  location.
- Consent screens show what you actually asked for.

Servers currently covered: DeepWiki, GitMCP, Cloudflare docs and Hugging Face need no
authorization; Stripe, Linear, Notion and Sentry all require it and all four support dynamic
registration with PKCE S256 and a public client.
