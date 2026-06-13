# The Dock content standard

Dock artifacts are ordinary HTML, Markdown, or static bundles. Two conventions
make them work well in the review loop: authoring so comments stay anchored, and
the anchor-client protocol that any viewer can speak.

## 1. Author for durable comments

Comments anchor to a **text quote** plus a little surrounding context (a W3C
`TextQuoteSelector`). When you republish, each open comment re-anchors against
the new version: exact match with context first, then exact match anywhere, and
if the text is gone it's marked "text changed" rather than silently moved. So
anchors survive edits as long as the text stays recognizable.

To keep comments attached across revisions:

- **Make local edits, not wholesale rewrites.** Fixing a clause keeps its
  neighbors as context; replacing a whole paragraph drops every anchor in it.
- **Keep headings and distinctive phrases stable.** They're the strongest
  context. Rename a heading only when you mean to.
- **Prefer real text over images of text.** Anchors need selectable text;
  baked-in screenshots can't be commented on.
- **Markdown:** one idea per paragraph, stable headings. **HTML/slides:** keep
  the readable text in the DOM (not generated late by script), so it's there
  when the page loads and when an anchor resolves.

These are guidelines, not validation — Dock never rejects content. They just
make the loop smoother.

## 2. The anchor-client protocol

Dock serves a small client at **`/raw/dock-client.js`** and references it from
served artifact HTML. It runs inside the sandboxed artifact iframe (opaque
origin), so the host page (the viewer) and the artifact communicate only by
`postMessage`. Any viewer can implement the host side; any host can serve a
compatible client. Messages are tagged with a `source` field.

### Artifact frame → host (`source: "dock"`)

| `type` | payload | meaning |
|---|---|---|
| `select` | `{ selector }` | user selected text; `selector` is a `TextQuoteSelector` (`{type, exact, prefix, suffix}`) or `null` when the selection cleared |
| `anchors-resolved` | `{ resolved: { [id]: boolean } }` | which anchor ids were found in the current document |
| `anchor-click` | `{ id }` | user clicked a painted highlight |

### Host → artifact frame (`source: "dock-host"`)

| `type` | payload | meaning |
|---|---|---|
| `anchors` | `{ anchors: [{ id, exact, prefix, suffix }] }` | paint these anchors as highlights; reply with `anchors-resolved` |
| `focus-anchor` | `{ id }` | scroll to + flash that anchor |

### Resolution

An anchor is located the same way on the client and the server: try
`prefix + exact + suffix` first, then `exact` alone; not found ⇒ unresolved.
Highlights wrap matched text in `<mark data-dock-id="…">`; clicking one posts
`anchor-click`.

### Why it's served, not inlined

Artifact HTML is cached immutably per version. If the client were baked into the
HTML, old artifacts would be frozen on old client behavior forever. Serving it at
a URL (short cache) lets the comment layer evolve independently of published
content — and lets other tools build their own viewers against this contract.

## 3. The deck protocol (slides)

An artifact that is a slide deck can announce itself so the Dock viewer shows a
presentation bar (prev / next / position / fullscreen) and can drive it. Like the
anchor client, it's pure `postMessage`. Opt-in: any HTML that posts these works;
anything that doesn't is served normally.

### Deck → host (`source: "dock-deck"`)

| `type` | payload | meaning |
|---|---|---|
| `state` | `{ i, total }` | current slide index (0-based) and slide count; post on load and on every change |

### Host → deck (`source: "dock-host"`)

| `type` | payload | meaning |
|---|---|---|
| `deck` | `{ action: "next" \| "prev" \| "goto", n? }` | advance, go back, or jump to slide `n` |

The deck owns its own rendering, keyboard, and on-screen controls; the host bar
is an additional driver. Fullscreen is host-side (it fullscreens the iframe
wrapper), so a deck needs no special support for it. `dock init --template slides`
scaffolds a deck that speaks this protocol.

## 4. The agent loop

`dock init` scaffolds an `AGENTS.md` describing publish → read comments → revise
→ reply/resolve over the HTTP API (and the matching `dock comments` / `reply` /
`resolve` / `open` verbs). That's the convention for agents (and humans) to close
the loop without prior knowledge of Dock.
