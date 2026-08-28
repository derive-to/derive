---
name: decks
summary: build a slide deck: the fixed stage, and the derive-deck protocol that earns the deck bar and per-slide comments (publish, read)
order: 4
---
# Building a deck

A deck is not a separate artifact kind. It is ONE single-file HTML artifact that speaks the
`derive-deck` protocol, and speaking it is what turns on everything the host adds: a
presentation bar (prev / next / position), Present mode, and review comments that pin to
the slide they were left on. A deck that skips the protocol still paginates and still looks
right, so nothing appears broken even though those features are missing.

Start from `derive://decks/template`: a complete, working deck with the structure below.
Restyle it entirely (palette, type, spacing, transition) and replace the slides. Keep the
four pieces this file calls load-bearing.

## Load-bearing structure

1. **One single file.** Never a multi-page bundle. A bundle technically paginates via
   links, but every slide change becomes a full page load inside the sandboxed iframe. There is
   no transition, no protocol, the gallery preview captures only the entry page, and
   bundles carry no facts. Kind is immutable on republish, so a bundle can never become a
   deck later: you would publish a new artifact and retire the old one.
2. **A fixed stage, scaled.** `.stage { position: fixed; left: 50%; top: 50%; width: 1280px;
   height: 720px; overflow: hidden }`, scaled to the viewport in JS on load and on resize:

   ```js
   const k = Math.min(innerWidth / 1280, innerHeight / 720) * 0.94
   stage.style.transform = `translate(-50%, -50%) scale(${k})`
   ```

   Both halves of that transform matter. **A transform does not change an element's layout
   size**, so a 720px stage scaled to 0.8 still occupies 720px in flow: centre it with grid
   or flex and it overflows any viewport shorter than 720px and gets clipped by
   `overflow: hidden`. Taking it out of flow with `position: fixed` and centring by
   translate is what makes the fit honest at every window size.

   Use fixed px type throughout. Do NOT use `clamp()` or `vw` sizing: a deck is fixed
   geometry, designed once, and a narrow window should shrink the whole composition rather
   than rewrap a slide. This is the opposite of the advice for an ordinary page.
3. **Slides that layer.** Each slide is `<section class="slide" data-derive-slide="N">`,
   all `position: absolute; inset: 0; opacity: 0`, revealed by a `.slide.on { opacity: 1 }`
   class with a ~0.32s opacity + transform transition. Document order is the slide order.
4. **The protocol.** Post your position to the host on load and on EVERY slide change, and
   accept its commands:

   ```js
   // deck → host, on every change. This single call is what makes it a deck.
   parent.postMessage({ source: "derive-deck", type: "state", i: at, total: slides.length }, "*")

   // host → deck
   window.addEventListener("message", (e) => {
     const d = e.data
     if (!d || d.source !== "derive-host" || d.type !== "deck") return
     if (d.action === "next") show(at + 1)
     else if (d.action === "prev") show(at - 1)
     else if (d.action === "goto") show(typeof d.n === "number" ? d.n : 0)
   })
   ```

Also give it a standalone fallback, so the file works opened directly: arrow / space /
PageUp / PageDown / Home / End keys, invisible left and right click zones, a progress bar,
an `n / total` counter, and `#sN` hash deep links. Fullscreen is host-side (it fullscreens
the iframe wrapper), so the deck needs nothing for Present mode beyond the protocol.

## `data-derive-slide` keeps comments where they belong

The index is each slide's stable identity, and comments anchor to it before anchoring to
the quoted text inside that slide. This stops the same phrase on two slides from
colliding. A comment made on slide 3 pins beside its text while slide 3 shows, and waits in
the comments drawer with a "Slide 3" badge otherwise; clicking it flips the deck there.

- When you insert a slide in the middle, APPEND the next unused index rather than
  renumbering the slides around it. Renumbering moves every later comment.
- Keep commented phrasing stable. The anchor re-matches on surrounding text, so small
  wording changes are fine, but rewriting a sentence orphans its thread.

## Reading one slide

`read(short_id, map:true)` lists the deck's slides with the `ref` that names each one, its
identity and its title; `read(short_id, node:"slide:4", format:"html")` returns that slide's
exact source. A slide is typically well under 1% of its deck, so this is how you work on one
without carrying the rest.

## Rearranging: `slide_ops`, not find-and-replace

To move, add, remove, or copy whole slides, pass `slide_ops` to `publish`, not `edits`.

```
publish(short_id, slide_ops: [{op: "move", from: 5, to: 2}, {op: "delete", at: 7}])
```

Ops are `{op:"move", from, to}`, `{op:"delete", at}`, `{op:"duplicate", at}` and
`{op:"insert", at}`, applied in order, each seeing the last one's result. `insert` creates a blank
slide in the nearest slide's outer visual shell. Positions are 1-based, matching the numbers the
deck bar shows a person, not the protocol's 0-based `i`; an insert position may be one past the end.

Reach for it because every alternative is bad in its own way. A quote edit cannot do it at
all: it refuses any span that crosses an element boundary. An `old_str` edit can only do it
by carrying two byte-perfect copies of the slide through your reply. That uses thousands of tokens
for an intent worth twenty, brittle against a single differing space, and worse the richer
the slide is. And `content` resends the whole deck. `slide_ops` sends positions: the slide's
markup never travels, so a move costs the same whether the slide holds one sentence or a
full-page SVG.

It is also the safe option. The server reads the real source, so `data-derive-slide` values
ride along untouched and comment threads stay with their slides. Ambiguous structure, such as a
slide nested inside another, content stranded between two slides, two slides claiming one
identity, causes the whole batch to fail with a specific error instead of applying part of it. Pass
`base_version` and a concurrent publish errors instead of clobbering. A deck whose slides
carry no `data-derive-slide` at all gets stamped on its first rearrange, so threads left
afterwards have something stable to hold.

Changes to a slide's words, styling, or images remain an ordinary
`edits` change. `slide_ops` is for which slides exist and what order they play in.

## Make top-level slide elements movable

The canonical template also opts each slide into source-safe structural editing. The slide is
the region, and only its direct authored children are nodes:

```html
<section class="slide" data-derive-slide="7"
  data-derive-region="slide-7" data-derive-layout="stack">
  <span data-derive-node="slide-7-label" data-derive-kind="label">Context</span>
  <h2 data-derive-node="slide-7-title" data-derive-kind="heading">The argument</h2>
  <div data-derive-node="slide-7-visual" data-derive-kind="visual">...</div>
</section>
```

Keep every node id unique and stable for the life of the deck. When adding a slide, derive the
region and node prefixes from that slide's next-unused `data-derive-slide` identity. A node owns
its complete subtree: a chart, card group, or text-and-visual composition can stay atomic inside
one direct child. Do not put a structural region inside a node, nest structural nodes, or leave
meaningful text/elements between the region's nodes. Those shapes fail closed instead of guessing
which source bytes belong to a move or removal.

Reorder and remove work from these identities without serializing the preview DOM. Resizing uses
the authored `compact`, `standard`, and `full` presets, so the deck must define their visual
meaning. The canonical fixed-stage mapping changes only inline width proportions:

```css
.slide > [data-derive-node][data-derive-size="compact"] { width: 50%; max-width: none }
.slide > [data-derive-node][data-derive-size="standard"] { width: 75%; max-width: none }
.slide > [data-derive-node][data-derive-size="full"] { width: 100%; max-width: none }
```

The canonical template authors this metadata directly. Legacy decks get a bounded optimistic
upgrade in Edit mode: Derive uses each exact-source slide as a region and stamps only its explicit,
direct source children as nodes. It never infers cards or ownership from runtime geometry. A slide
with loose text, an implicitly closed direct child, or a direct `script`, `style`, or `template`
stays unsupported while independently safe slides remain movable. Direct SVG/MathML should sit in
an HTML wrapper so the interaction client can focus and size that wrapper. A partial structural
contract is never completed automatically. The effective preview and first inline save run the
same deterministic transform, and that first save persists the stable identities plus fallback
`compact` / `standard` / `full` width rules. Whole-slide `slide_ops` remain available either way.

## Every slide carries a visual AND words

The most common way a finished deck goes flat is slides that are all text or all picture.
The visual should carry an argument the sentence cannot: a diagram of the flow being
described, a fan-out from one input to four outcomes, the same figure marked up two ways.
Inline SVG is usually the right tool because it needs no assets and scales with the stage. For a
screenshot slide, pair the image with a short numbered list of what to look at, never a
bare caption.

Two layout rules that come up every time:

- **Fill the stage.** Content lands top-heavy and looks stranded. Give the content grid
  `flex: 1; min-height: 0; align-content: center` so it absorbs the leftover height and
  centres its own rows, while the eyebrow and heading stay pinned at the same position on
  every slide. Do not centre the whole slide; headings will jump between slides.
- **Let an image size itself.** Never `width: 100%; object-fit: contain` on a slide image:
  `object-fit` letterboxes the picture but the element box stays full width, so the border
  frames a large empty panel beside it. `aspect-ratio` does not fix it either. Wrap it in a
  flex frame and cap both axes with `max-width: 100%; max-height: 100%; width: auto;
  height: auto`. The element box then matches the painted picture at any source ratio.

## Verifying a deck

`read({ render: "full" })` only ever captures slide 1: the deck is a JS switcher, so a
screenshot of the served page shows whichever slide is current at load. That is enough to
check slide 1 and the overall styling, and it is the check to run after publishing.

To check interior slides, open the local file in a browser you drive and step through it:

- A screenshot taken immediately after a keypress catches the crossfade with two slides
  stacked. That is the transition, not a bug. Take the screenshot again after another call. For
  deterministic captures, kill the transition first
  (`document.querySelectorAll(".slide").forEach((s) => (s.style.transition = "none"))`)
  and toggle the `.on` class per slide instead of sleeping between keypresses.
- Wrap any expression you evaluate in the page in an IIFE. Decks keep their slide index in
  a short global (`i`, `n`, `at`), and declaring a bare `var i` in an evaluated snippet
  clobbers it, which looks exactly like a deck bug.
- The fixed stage clips silently, so overflow is invisible. Sweep it cheaply: for each
  slide, compare every descendant's `getBoundingClientRect()` bottom and right against the
  slide's own.

## Publishing one

Publish the HTML as ordinary single-file `content` (see `derive://skills/publishing`). Two
things confirm it worked: the response's content type is `text/x-derive-deck` and the
library badges it **Deck**. If a publish advisory says the page has slide elements but
never posts `derive-deck`, the protocol is missing. The deck bar, Present mode, and
slide-pinned comments are all off until it is added.
