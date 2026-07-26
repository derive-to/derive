# derive-html

Writing HTML artifacts for Derive. HTML is served sandboxed in an opaque origin
with the anchor client injected automatically.

---

## The sandbox

Every HTML artifact is served with:

```
Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads
```

What this means:
- Scripts run (`allow-scripts`)
- Forms and popups work (`allow-forms allow-popups`)
- **No cookies, no localStorage, no sessionStorage** (sandbox restriction)
- **No cross-origin requests** to external APIs without CORS (sandbox restriction)
- **No same-origin access** to the Derive API (different registrable domain)

Design HTML artifacts to be self-contained. Don't rely on cookies for state,
don't try to fetch Derive's API from inside the artifact, don't rely on parent-frame
access (the sandbox blocks `document.domain` tricks).

---

## Anchor client (auto-injected)

Derive injects `/raw/derive-client.js` into every served HTML artifact. It handles:
- Text selection capture -> sends `{ type: "select", rect, selector }` to the parent
- Highlight painting when the host sends anchor data
- Scroll-to-anchor on focus commands from the host
- Cursor position reporting for multiplayer cursors

You don't need to include this script yourself. Don't try to block or remove it —
comments won't work without it.

The script communicates with the Derive host via `postMessage`. Your own page scripts
can also use `postMessage` freely; just avoid using `source: "derive"` or
`source: "derive-host"` as your message origin (those are Derive's reserved prefixes).

---

## Writing HTML that anchors well

Comments anchor to exact text using TextQuoteSelector (`{ exact, prefix, suffix }`).
To make comments durable across revisions:

- **Put content in real text nodes.** `<p>`, `<li>`, `<h2>`, `<td>`, `<span>` — text in
  these elements is selectable and anchorable. Text inside `<canvas>`, `<svg>`, or
  image alt attributes is not.
- **Keep key phrases stable.** If a comment is anchored to "The system resolves
  ambiguities at query time", that exact string needs to survive future revisions for
  the anchor to stay live.
- **Prefer text over images of text.** Screenshots and diagrams can't be commented
  on at the word level.
- **Use meaningful `id` attributes on sections.** They don't directly affect anchoring,
  but they help with jump-links and anchor context.

---

## Minimal working HTML structure

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My doc</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 0 auto; padding: 48px 24px; }
  </style>
</head>
<body>
  <h1>Title</h1>
  <p>Content here is selectable and anchorable.</p>
</body>
</html>
```

No external CSS frameworks, no fonts that require CORS requests, no localStorage.

---

## External resources

You can load external CSS and fonts from CDNs as long as they support CORS. The sandbox
doesn't block fetching public resources — it blocks same-origin Derive API access and
storage.

Google Fonts works:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter&display=swap" rel="stylesheet">
```

---

## The postMessage API (advanced)

If your page needs to respond to Derive's anchor system:

**Messages your page receives from Derive:**
```js
window.addEventListener('message', e => {
  if (e.data?.source !== 'derive-host') return
  // e.data.type: 'anchors', 'emphasize', 'focus-anchor', 'scroll-by'
})
```

**Messages Derive's injected script sends to the host (for reference):**
```js
// Text selected
{ type: 'select', rect: DOMRect, selector: TextQuoteSelector }

// Selection cleared
{ type: 'select', selector: null, rect: null }

// Live scroll position
{ type: 'scroll', scrollY, viewH, docH }
```

Your page doesn't need to handle these — the injected anchor client does it automatically.
