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
right, so nothing appears broken — it has just silently given all of that up.

Start from `derive://decks/template`: a complete, working deck with the structure below.
Restyle it entirely (palette, type, spacing, transition) and replace the slides. Keep the
four pieces this file calls load-bearing.

## Load-bearing structure

1. **One single file.** Never a multi-page bundle. A bundle technically paginates via
   links, but every slide change becomes a full page load inside the sandboxed iframe —
   no transition, no protocol, the gallery preview captures only the entry page, and
   bundles carry no facts. Kind is immutable on republish, so a bundle can never become a
   deck later: you would publish a new artifact and retire the old one.
2. **A fixed stage, scaled.** `.stage { position: relative; width: 1280px; height: 720px;
   overflow: hidden }`, scaled to the viewport in JS on load and on resize:

   ```js
   stage.style.transform = "scale(" + Math.min(innerWidth / 1280, innerHeight / 720) * 0.94 + ")"
   ```

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
the quoted text inside that slide — which is what stops the same phrase on two slides from
colliding. A comment made on slide 3 pins beside its text while slide 3 shows, and waits in
the comments drawer with a "Slide 3" badge otherwise; clicking it flips the deck there.

- When you insert a slide in the middle, APPEND the next unused index rather than
  renumbering the slides around it. Renumbering moves every later comment.
- Keep commented phrasing stable. The anchor re-matches on surrounding text, so small
  wording changes are fine, but rewriting a sentence orphans its thread.

## Every slide carries a visual AND words

The most common way a finished deck goes flat is slides that are all text or all picture.
The visual should carry an argument the sentence cannot: a diagram of the flow being
described, a fan-out from one input to four outcomes, the same figure marked up two ways.
Inline SVG is usually the right tool — it needs no assets and scales with the stage. For a
screenshot slide, pair the image with a short numbered list of what to look at, never a
bare caption.

Two layout rules that come up every time:

- **Fill the stage.** Content lands top-heavy and looks stranded. Give the content grid
  `flex: 1; min-height: 0; align-content: center` so it absorbs the leftover height and
  centres its own rows, while the eyebrow and heading stay pinned at the same position on
  every slide. Do NOT centre the whole slide — headings then jump slide to slide.
- **Let an image size itself.** Never `width: 100%; object-fit: contain` on a slide image:
  `object-fit` letterboxes the picture but the element box stays full width, so the border
  frames a large empty panel beside it. `aspect-ratio` does not fix it either. Wrap it in a
  flex frame and cap on BOTH axes — `max-width: 100%; max-height: 100%; width: auto;
  height: auto` — and the element box becomes the painted picture at any source ratio.

## Verifying a deck

`read({ render: "full" })` only ever captures slide 1: the deck is a JS switcher, so a
screenshot of the served page shows whichever slide is current at load. That is enough to
check slide 1 and the overall styling, and it is the check to run after publishing.

To check interior slides, open the local file in a browser you drive and step through it:

- A screenshot taken immediately after a keypress catches the crossfade with two slides
  stacked. That is the transition, not a bug — re-shoot after any intervening call. For
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
never posts `derive-deck`, that is this protocol missing — the deck bar, Present mode, and
slide-pinned comments are all off until it is added.
