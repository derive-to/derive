# The Derive artifact authoring standard

Derive artifacts are ordinary HTML, Markdown, or static bundles. Two conventions
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

These are guidelines, not validation — Derive never rejects content. They just
make the loop smoother.

## 2. The anchor-client protocol

Derive serves a small client at **`/raw/derive-client.js`** and references it from
served artifact HTML. It runs inside the sandboxed artifact iframe (opaque
origin), so the host page (the viewer) and the artifact communicate only by
`postMessage`. Any viewer can implement the host side; any host can serve a
compatible client. Messages are tagged with a `source` field.

### Artifact frame → host (`source: "derive"`)

| `type` | payload | meaning |
|---|---|---|
| `select` | `{ selector }` | user selected text; `selector` is a `TextQuoteSelector` (`{type, exact, prefix, suffix}`) or `null` when the selection cleared |
| `anchors-resolved` | `{ resolved: { [id]: boolean } }` | which anchor ids were found in the current document |
| `anchor-click` | `{ id }` | user clicked a painted highlight |
| `open-external` | `{ href }` | a link that must not navigate the frame (anything but an in-page `#` or a same-origin `/raw/…` bundle page); the host validates the scheme, routes its own `/artifacts/…` in-app, and opens the rest in a new tab |
| `esc` | — | Escape pressed while focus was inside the frame; the host applies its own dismissals (e.g. exiting focus mode) |
| `edit-state` | `{ dirty }` | inline edit mode: how many blocks currently differ from the pre-edit snapshot (formatting counts, even when no character changed) |
| `edit-edits` | `{ edits: [{ quote: { exact, prefix, suffix }, new_text? , new_html? }], dirty, uncaptured, nonce }` | reply to `edit-collect`: each changed run as a quote-scoped edit, built from the PRE-edit document text. A formatted block comes back as ONE `new_html` edit for the whole block instead of per-run text edits. `dirty` is the changed-block count at collect time and `uncaptured` how many of those produced no edit — the host refuses a partial save rather than publishing some of the work and letting the reload drop the rest. `nonce` echoes the request's, so a late reply can't resolve a newer collect |
| `edit-save` | — | ⌘S / ⌘Enter pressed inside the frame (the host's own window listener cannot see keys typed in the iframe); the host saves if there are pending edits |
| `edit-request` | — | a double-click on text, asking the host to open edit mode; the client has already captured which text node it was, and the host answers with `edit-mode {on:true, fromPointer:true}` |
| `edit-image` | `{ src, alt }` | an image was clicked in edit mode; the host uploads a replacement and swaps that URL |
| `edit-blocked` | `{ reason }` | a gesture landed where inline editing can't reach: `"control"` (a form control/media), `"dynamic"` (content the page's own script created after the snapshot), `"offscreen"` (a slide that isn't the one on screen), `"embedded-image"` (a `data:` URI — no URL to swap), `"format-empty"` / `"format-outside"` / `"format-range"` (nothing selected, selection outside a block, or a selection that only half-contains an element) |
| `present` | — | `p` pressed inside the frame; the host toggles present mode (a click into the document moves keyboard focus here, where the host's own listener can't see it) |
| `deck-sniff` | `{ i, total }` | this document LOOKS like a deck (switched slides) though it never announced itself — see §3 |

### Host → artifact frame (`source: "derive-host"`)

| `type` | payload | meaning |
|---|---|---|
| `anchors` | `{ anchors: [{ id, exact, prefix, suffix }] }` | paint these anchors as highlights; reply with `anchors-resolved` |
| `focus-anchor` | `{ id }` | scroll to + flash that anchor |
| `edit-mode` | `{ on, keep?, fromPointer?, fromSelection? }` | enter/leave inline edit mode. On entry the client snapshots the document text (quotes are built from it); a click then lands a caret in the nearest text block (`contenteditable`, plain text only — paste flattened, Enter inserts a line break), the block under the pointer is lit as an invitation, and while a caret is in a block the PAGE'S OWN keyboard and click handlers are suppressed (a deck's slide keys would otherwise fire as you type). `fromPointer` lands the caret on the text whose double-click asked for the mode; `fromSelection` on the live selection. `keep:true` on the way out leaves the typed text standing and only removes the editing chrome — used right after a publish, where the text on screen is what was just saved. Leaving restores anything unsaved unless `keep` |
| `edit-armed` | `{ on }` | whether this viewer may edit; arms the document's own entry gesture (a double-click asks for the mode) so a reader who could never save never fires one |
| `edit-collect` | `{ nonce }` | reply with `edit-edits` echoing `nonce`: the changed runs diffed against the snapshot, word-snapped, as quote-scoped edits |
| `edit-restore` | — | revert every edited block to its snapshot (the Discard verb); dirty drops to 0 |

### Formatting

A manual edit is plain text with one exception: a run the reader made **bold**,
*italic*, a **link**, or broke with Enter comes back as `new_html` instead of
`new_text`. The server sanitizes it to five inline tags (`b`, `i`, `code`, `br`,
`a[href]`, plus their `strong`/`em` spellings) with no other attributes and only
http / https / mailto links. Everything else about the edit is unchanged: located
by quote, unique or refused, never crossing the document's own markup. On a
Markdown artifact `new_html` is refused — formatting there is Markdown text.

### Resolution

An anchor is located the same way on the client and the server: try
`prefix + exact + suffix` first, then `exact` alone; not found ⇒ unresolved.
Highlights wrap matched text in `<mark data-derive-id="…">`; clicking one posts
`anchor-click`.

### Why it's served, not inlined

Artifact HTML is cached immutably per version. If the client were baked into the
HTML, old artifacts would be frozen on old client behavior forever. Serving it at
a URL (short cache) lets the comment layer evolve independently of published
content — and lets other tools build their own viewers against this contract.

## 3. The deck protocol (slides)

An artifact that is a slide deck can announce itself so the Derive viewer shows a
presentation bar (prev / next / position / present) and can drive it. Like the
anchor client, it's pure `postMessage`. Opt-in: any HTML that posts these works;
anything that doesn't is served normally.

**A deck that says nothing still gets the bar.** The protocol is younger than most
decks, so the injected client also SNIFFS one: slides whose visibility is switched
(one shown, the rest hidden) is a deck whatever it says about itself, and it
reports the position as `deck-sniff`. A page whose `.slide` sections are all
visible is a long page and stays one. An artifact that announces itself always
wins — once a `derive-deck` message arrives the sniff is ignored — and that also
decides who moves it: a protocol deck answers `deck`, a sniffed one is driven by
the client (`deck-drive`), which synthesizes the key the page already listens for
so the page's own index, progress bar and counter stay true.

### Deck → host (`source: "derive-deck"`)

| `type` | payload | meaning |
|---|---|---|
| `state` | `{ i, total }` | current slide index (0-based) and slide count; post on load and on every change |

### Host → deck (`source: "derive-host"`)

| `type` | payload | meaning |
|---|---|---|
| `deck` | `{ action: "next" \| "prev" \| "goto", n? }` | advance, go back, or jump to slide `n` |

The deck owns its own rendering, keyboard, and on-screen controls; the host bar
is an additional driver. `derive init --template slides` scaffolds a deck that
speaks this protocol.

### Present mode

Present is host-side, so a deck needs no support for it: the viewer fullscreens
the frame (falling back to a full-viewport overlay where the Fullscreen API is
refused, as on iOS), hides every other piece of chrome, drives the deck from the
keyboard (arrows, Space, PageUp/PageDown, Home/End), and quiets its own controls
when nothing has happened for a beat. `p` enters, Escape leaves, `?present=1`
opens straight into it. Two things a deck should nonetheless do, because they are
what the viewer builds on: give each slide a stable `data-derive-slide="N"`, and
keep its own click zones off the words — a click on text belongs to the text, and
for someone who can edit the artifact, the viewer treats it that way.

### Editing a deck

A deck is editable like any other artifact. While a caret is in a block, the
client takes the keyboard and clicks away from the page, so Space types a space
instead of advancing, and off-screen slides stop catching clicks aimed at the
slide on screen. With no caret in a block the deck keeps its keyboard, so you can
still walk to slide 7 and then click a line to fix it.

## 4. The agent loop

`derive init` scaffolds an `AGENTS.md` describing publish → read comments → revise
→ reply/resolve over the HTTP API (and the matching `derive comments` / `reply` /
`resolve` / `open` verbs). That's the convention for agents (and humans) to close
the loop without prior knowledge of Derive.
