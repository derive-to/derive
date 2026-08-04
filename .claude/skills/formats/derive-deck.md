# derive-deck

Writing HTML slide decks for Derive. Derive detects the deck structure automatically
and wires up a nav bar and present mode — no configuration needed.

---

## What makes a deck

Derive labels an artifact a **Deck** — and overlays the nav bar + present mode — when its
HTML speaks the `derive-deck` protocol (it posts its slide position to the host). Two
ingredients:

1. **Slide elements**, one per slide, each with a stable index:
   `<section class="slide" data-derive-slide="0">`. Document order is the slide order.
2. **The protocol**: your script posts `{ source: 'derive-deck', type: 'state', i, total }`
   on every slide change and listens for the host's `next` / `prev` / `goto` commands
   (below). Posting that message once is what flips the artifact to a Deck.

A deck that only has ingredient 1 still gets the bar: Derive's client recognises
switched slides (one shown, the rest hidden) and reports the position on the deck's
behalf, so every deck written before the protocol existed presents fine. Speak the
protocol anyway when you can — a deck that answers `next`/`prev` itself keeps its own
counter and progress bar in step, which the fallback can only approximate.

```html
<section class="slide" data-derive-slide="0">
  <h1>First slide</h1>
  <p>Content here.</p>
</section>

<section class="slide" data-derive-slide="1">
  <h2>Second slide</h2>
  <p>More content.</p>
</section>
```

`data-derive-slide="N"` is each slide's stable identity — it's what keeps comments and
cursors pinned to the right slide (see "Comments land on the right slide" below). Plain
`<section class="slide">` still works (document order is used as the index); the explicit
attribute is what keeps comments correct when slides are added, removed, or reordered.

---

## The postMessage protocol

The Derive host drives the deck via postMessage. The deck reports its position back.

**Deck reports state to host (send on every slide change):**
```js
parent.postMessage({
  source: 'derive-deck',
  type: 'state',
  i: 0,          // current slide index (0-based)
  total: 8       // total number of slides
}, '*')
```

**Host commands the deck:**
```js
// Received by the deck from the host
{ source: 'derive-host', type: 'deck', action: 'next' }
{ source: 'derive-host', type: 'deck', action: 'prev' }
{ source: 'derive-host', type: 'deck', action: 'goto', n: 3 }  // 0-based
```

Implement the message listener in your deck script:
```js
window.addEventListener('message', function(e) {
  var d = e.data
  if (!d || d.source !== 'derive-host' || d.type !== 'deck') return
  if (d.action === 'next') show(i + 1)
  else if (d.action === 'prev') show(i - 1)
  else if (d.action === 'goto') show(typeof d.n === 'number' ? d.n : 0)
})
```

---

## Standalone fallback

Add keyboard and click navigation so the deck works when opened directly (outside Derive):

```js
// `editing`: someone is typing in this deck (Derive's inline editor makes a block
// contenteditable). Without the guard, a space types nothing and advances the slide.
// Derive's own client also suppresses these keys while a caret is in a block, so a
// deck is safe inside the viewer either way — this is for a deck opened directly.
function editing() {
  var el = document.activeElement
  return !!(el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName)))
}

document.addEventListener('keydown', function(e) {
  if (editing()) return
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault(); show(i + 1)
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault(); show(i - 1)
  } else if (e.key === 'Home') show(0)
  else if (e.key === 'End') show(slides.length - 1)
})

// Keep click-to-advance OFF the words: aim the zones at the margins rather than the
// whole stage. A click on a headline is someone reaching for the headline.
document.addEventListener('click', function(e) {
  if (editing()) return
  if (window.getSelection && String(window.getSelection())) return  // don't fire on text selection
  if (e.target.closest('h1,h2,h3,p,li,figcaption,a,img')) return
  show(e.clientX > window.innerWidth / 2 ? i + 1 : i - 1)
})
```

---

## Minimal complete deck

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My Deck</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0 }
  html, body { height: 100%; overflow: hidden }
  body { font-family: system-ui, sans-serif; background: #f6f0e3; color: #2a2540 }
  .deck { position: fixed; inset: 0; display: grid; place-items: center }
  .slide {
    position: absolute; inset: 0; display: none; flex-direction: column;
    justify-content: center; padding: 8vmin 10vmin;
    opacity: 0; transform: translateY(14px);
    transition: opacity .35s, transform .35s;
  }
  .slide.on { display: flex; opacity: 1; transform: none }
  h1 { font-size: clamp(36px, 7vmin, 80px); line-height: 1.05; margin-bottom: .3em }
  p { font-size: clamp(16px, 2.4vmin, 28px); color: #5e5878 }
  footer { position: fixed; bottom: 0; left: 0; right: 0;
    display: flex; justify-content: space-between;
    padding: 2vmin 3vmin; font-size: 13px; color: #5e5878 }
</style>
</head>
<body>
<main class="deck" id="deck">
  <section class="slide" data-derive-slide="0">
    <h1>First slide</h1>
    <p>Opening line here.</p>
  </section>
  <section class="slide" data-derive-slide="1">
    <h1>Second slide</h1>
    <p>Next idea here.</p>
  </section>
</main>
<footer>
  <span>My Deck</span>
  <span>← → to navigate</span>
  <span id="count">1 / 2</span>
</footer>
<script>
(function() {
  var slides = Array.from(document.querySelectorAll('.slide'))
  var count = document.getElementById('count')
  var i = 0

  function report() {
    try { parent.postMessage({ source: 'derive-deck', type: 'state', i: i, total: slides.length }, '*') } catch(e) {}
  }
  function show(n) {
    i = Math.max(0, Math.min(slides.length - 1, n))
    slides.forEach((s, k) => s.classList.toggle('on', k === i))
    if (count) count.textContent = (i + 1) + ' / ' + slides.length
    report()
  }

  window.addEventListener('message', function(e) {
    var d = e.data
    if (!d || d.source !== 'derive-host' || d.type !== 'deck') return
    if (d.action === 'next') show(i + 1)
    else if (d.action === 'prev') show(i - 1)
    else if (d.action === 'goto') show(typeof d.n === 'number' ? d.n : 0)
  })
  // Not while someone is typing in the deck (see "Standalone fallback").
  function editing() {
    var el = document.activeElement
    return !!(el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName)))
  }
  document.addEventListener('keydown', function(e) {
    if (editing()) return
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); show(i + 1) }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(i - 1) }
    else if (e.key === 'Home') show(0)
    else if (e.key === 'End') show(slides.length - 1)
  })
  document.addEventListener('click', function(e) {
    if (editing()) return
    if (window.getSelection && String(window.getSelection())) return
    if (e.target.closest('h1,h2,h3,p,li,figcaption,a,img')) return  // a click on words is not "next"
    show(e.clientX > window.innerWidth / 2 ? i + 1 : i - 1)
  })

  show(0)
})()
</script>
</body>
</html>
```

---

## Presenting, and editing

**Present** is Derive's, not yours: the viewer fullscreens the deck (or covers the
viewport where fullscreen is refused, as on iOS), hides every other piece of chrome,
drives the deck with arrows / Space / PageUp / PageDown / Home / End, and fades its
own bar when the room settles. `p` enters, Escape leaves, and `?present=1` on the
artifact URL opens straight into it — that's the link to put in the calendar invite.

**Editing** works on a deck like any other artifact: double-click a headline and
type. While a caret is in a block, Derive's client takes the keyboard and clicks away
from your page, so a space types a space instead of advancing, and off-screen slides
stop catching clicks meant for the one on screen. Two things make that smoother:
keep click zones off the words (above), and hide inactive slides in a way a reader
would recognise (`opacity` or `display` on `.slide` / `.slide.on`), which is also how
the viewer finds the slides in the first place.

---

## Comments land on the right slide

Reviewers comment on any slide, and Derive keeps each comment tied to its slide:

- A comment made on slide 3 pins beside its text **only while slide 3 is showing**. On
  other slides it waits in the comments drawer with a "Slide 3" badge; clicking it flips
  the deck to slide 3 and opens the thread.
- Live cursors are scoped per slide — you see a collaborator's cursor only while you're
  both on the same slide.
- If you republish and a commented phrase has moved to a different slide, the comment
  follows its text to the new slide and is flagged "moved" so you can re-confirm it.

This works because each comment is anchored to its slide's `data-derive-slide` index, then
to the quoted text within that slide — so the same phrase on two slides never collides.
Two things keep comments live across edits:

- Give every slide a stable `data-derive-slide="N"` (don't renumber existing slides when
  you insert one in the middle — append the new index instead).
- Keep the commented phrases themselves stable; the anchor re-matches on the surrounding
  text (a TextQuoteSelector), so small wording changes are fine but rewriting the
  sentence orphans the thread.

---

## Styling tips

- Use `clamp()` for font sizes so text scales with viewport: `clamp(36px, 7vmin, 80px)`
- Use `overflow: hidden` on `body` to prevent scroll between slides
- Use `position: fixed; inset: 0` on `.deck` for full-viewport layout
- Use `display: none` / `display: flex` toggled by a class (`.on`) for slide transitions
- CSS transitions on `opacity` and `transform: translateY()` give smooth slide entrance
