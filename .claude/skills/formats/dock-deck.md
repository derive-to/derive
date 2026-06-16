# dock-deck

Writing HTML slide decks for Dock. Dock detects the deck structure automatically
and wires up a nav bar and present mode — no configuration needed.

---

## What makes a deck

Dock labels an artifact a **Deck** — and overlays the nav bar + present mode — when its
HTML speaks the `dock-deck` protocol (it posts its slide position to the host). Two
ingredients:

1. **Slide elements**, one per slide, each with a stable index:
   `<section class="slide" data-dock-slide="0">`. Document order is the slide order.
2. **The protocol**: your script posts `{ source: 'dock-deck', type: 'state', i, total }`
   on every slide change and listens for the host's `next` / `prev` / `goto` commands
   (below). Posting that message once is what flips the artifact to a Deck.

```html
<section class="slide" data-dock-slide="0">
  <h1>First slide</h1>
  <p>Content here.</p>
</section>

<section class="slide" data-dock-slide="1">
  <h2>Second slide</h2>
  <p>More content.</p>
</section>
```

`data-dock-slide="N"` is each slide's stable identity — it's what keeps comments and
cursors pinned to the right slide (see "Comments land on the right slide" below). Plain
`<section class="slide">` still works (document order is used as the index); the explicit
attribute is what keeps comments correct when slides are added, removed, or reordered.

---

## The postMessage protocol

The Dock host drives the deck via postMessage. The deck reports its position back.

**Deck reports state to host (send on every slide change):**
```js
parent.postMessage({
  source: 'dock-deck',
  type: 'state',
  i: 0,          // current slide index (0-based)
  total: 8       // total number of slides
}, '*')
```

**Host commands the deck:**
```js
// Received by the deck from the host
{ source: 'dock-host', type: 'deck', action: 'next' }
{ source: 'dock-host', type: 'deck', action: 'prev' }
{ source: 'dock-host', type: 'deck', action: 'goto', n: 3 }  // 0-based
```

Implement the message listener in your deck script:
```js
window.addEventListener('message', function(e) {
  var d = e.data
  if (!d || d.source !== 'dock-host' || d.type !== 'deck') return
  if (d.action === 'next') show(i + 1)
  else if (d.action === 'prev') show(i - 1)
  else if (d.action === 'goto') show(typeof d.n === 'number' ? d.n : 0)
})
```

---

## Standalone fallback

Add keyboard and click navigation so the deck works when opened directly (outside Dock):

```js
document.addEventListener('keydown', function(e) {
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
    e.preventDefault(); show(i + 1)
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault(); show(i - 1)
  } else if (e.key === 'Home') show(0)
  else if (e.key === 'End') show(slides.length - 1)
})

document.addEventListener('click', function(e) {
  if (window.getSelection && String(window.getSelection())) return  // don't fire on text selection
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
  <section class="slide" data-dock-slide="0">
    <h1>First slide</h1>
    <p>Opening line here.</p>
  </section>
  <section class="slide" data-dock-slide="1">
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
    try { parent.postMessage({ source: 'dock-deck', type: 'state', i: i, total: slides.length }, '*') } catch(e) {}
  }
  function show(n) {
    i = Math.max(0, Math.min(slides.length - 1, n))
    slides.forEach((s, k) => s.classList.toggle('on', k === i))
    if (count) count.textContent = (i + 1) + ' / ' + slides.length
    report()
  }

  window.addEventListener('message', function(e) {
    var d = e.data
    if (!d || d.source !== 'dock-host' || d.type !== 'deck') return
    if (d.action === 'next') show(i + 1)
    else if (d.action === 'prev') show(i - 1)
    else if (d.action === 'goto') show(typeof d.n === 'number' ? d.n : 0)
  })
  document.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); show(i + 1) }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(i - 1) }
    else if (e.key === 'Home') show(0)
    else if (e.key === 'End') show(slides.length - 1)
  })
  document.addEventListener('click', function(e) {
    if (window.getSelection && String(window.getSelection())) return
    show(e.clientX > window.innerWidth / 2 ? i + 1 : i - 1)
  })

  show(0)
})()
</script>
</body>
</html>
```

---

## Comments land on the right slide

Reviewers comment on any slide, and Dock keeps each comment tied to its slide:

- A comment made on slide 3 pins beside its text **only while slide 3 is showing**. On
  other slides it waits in the comments drawer with a "Slide 3" badge; clicking it flips
  the deck to slide 3 and opens the thread.
- Live cursors are scoped per slide — you see a collaborator's cursor only while you're
  both on the same slide.
- If you republish and a commented phrase has moved to a different slide, the comment
  follows its text to the new slide and is flagged "moved" so you can re-confirm it.

This works because each comment is anchored to its slide's `data-dock-slide` index, then
to the quoted text within that slide — so the same phrase on two slides never collides.
Two things keep comments live across edits:

- Give every slide a stable `data-dock-slide="N"` (don't renumber existing slides when
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
